import { readAuthenticatedJsonBody } from "@/lib/request-body";
import { withPrimaryUrl } from "@/lib/repositories";
import { NextResponse } from "next/server";
import { duplicateKeyField } from "@/lib/mongo-errors";
import { isValidProjectKey, PROJECT_KEY_RULE } from "@/lib/identifiers";
import { connectDB } from "@/lib/db";
import { withAuth, withAdmin } from "@/lib/middleware";
import { accessibleProjectIds, administeredProjectIds } from "@/lib/grants";
import { LEGACY_FIELD_NAMES, legacyFieldSeeds } from "@/lib/legacy-fields";
import { auditAccess, announceAccess } from "@/lib/board-access";
import { parseProjectSetup } from "@/lib/project-setup";
import { logProjectAudit } from "@/lib/projectAudit";
import { sanitizeMcpServers } from "@/lib/pm/config";
import { sanitizeProjectSecrets } from "@/lib/project-secrets";
import { NOT_ARCHIVED } from "@/lib/task-archive";

export const GET = withAuth(async (_request, { user, db }) => {
  await connectDB();

  const accessibleIds = await accessibleProjectIds(db, user);
  const filter = accessibleIds === null ? {} : { _id: { $in: accessibleIds } };

  // Manual order first; anything never dragged keeps its default 0 and falls
  // back to newest-first, which is the order this list had before CP-180
  const projects = await db.Project.find(filter)
    .populate("createdBy", "username fullName")
    .sort({ sortOrder: 1, createdAt: -1 });

  // The sidebar renders on every route, so its per-project badges have to come
  // from this one request. Two flat queries joined in memory rather than a
  // $lookup with an inline pipeline, which needs MongoDB 5.0.
  const ids = projects.map((p) => p._id);
  const [taskStats, activeSprints] = await Promise.all([
    db.Task.aggregate([
      { $match: { project: { $in: ids }, ...NOT_ARCHIVED } },
      {
        $group: {
          _id: "$project",
          taskCount: { $sum: 1 },
        },
      },
    ]),
    db.Sprint.find({ project: { $in: ids }, status: "active" }).select("project").lean(),
  ]);

  const statsByProject = new Map(taskStats.map((s) => [String(s._id), s]));
  const withActiveSprint = new Set(activeSprints.map((s) => String(s.project)));

  const administered = await administeredProjectIds(db, user, ids.map(String));
  const sanitized = projects.map((p) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: any = sanitizeProjectSecrets(p.toObject(), db.organisation);
    if (obj.pm) obj.pm.mcpServers = sanitizeMcpServers(obj.pm.mcpServers);

    const stats = statsByProject.get(String(p._id));
    obj.taskCount = stats?.taskCount ?? 0;
    obj.hasActiveSprint = withActiveSprint.has(String(p._id));
    obj.canAdmin = administered.has(String(p._id));
    return obj;
  });
  return NextResponse.json(sanitized);
});

export const POST = withAdmin(async (request, { user, db }) => {
  await connectDB();
  const read = await readAuthenticatedJsonBody(request);
  if (!read.ok) return read.response;
  const body = read.value;
  const { name, key, description } = body;

  if (!name || !key) {
    return NextResponse.json(
      { error: "name and key are required" },
      { status: 400 }
    );
  }

  // Stored uppercase, so validate what will be stored rather than what was typed
  const storedKey = String(key).trim().toUpperCase();
  if (!isValidProjectKey(storedKey)) {
    return NextResponse.json({ error: PROJECT_KEY_RULE }, { status: 400 });
  }

  const parsed = parseProjectSetup(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const setup = parsed.value;

  // The creator is the owner already; naming them again would be a second grant on the same pair
  const others = setup.access.filter((a) => a.userId !== String(user._id));
  const people = others.length
    ? await db.User.find({
        _id: { $in: others.map((a) => a.userId) },
        kind: { $ne: "machine" },
        deactivatedAt: null,
      })
        .select("username")
        .lean()
    : [];
  if (people.length !== others.length) {
    return NextResponse.json(
      { error: "Some of the people you chose no longer exist or are deactivated. Nothing was created." },
      { status: 400 }
    );
  }

  // A fresh project looks like a fresh project always did — the difference is
  // that all three are now editable and removable (CP-213)
  const customFields = legacyFieldSeeds({});
  for (const [fieldName, options] of [
    [LEGACY_FIELD_NAMES.component, setup.components],
    [LEGACY_FIELD_NAMES.labels, setup.labels],
  ] as const) {
    const field = customFields.find((f) => f.name === fieldName);
    if (field && options) field.options = options;
  }

  let project;
  try {
    project = await db.Project.create({
      name,
      key: storedKey,
      description: description || "",
      createdBy: user._id,
      customFields,
      ...(setup.icon !== undefined && { icon: setup.icon }),
      ...(setup.columns && { columns: setup.columns }),
      ...(setup.categories && { categories: setup.categories }),
      ...(setup.repositoryUrl && { repositoryUrl: setup.repositoryUrl, repositories: withPrimaryUrl([], setup.repositoryUrl) }),
      ...(setup.pmEnabled !== undefined && { pm: { enabled: setup.pmEnabled } }),
    });
  } catch (e) {
    if (duplicateKeyField(e)) {
      return NextResponse.json(
        { error: "That key is already used by another board" },
        { status: 409 }
      );
    }
    throw e;
  }

  try {
    await db.Grant.create({
      subject: user._id,
      relation: "owner",
      objectType: "project",
      object: project._id,
      createdBy: user._id,
    });
    if (others.length > 0) {
      await db.Grant.insertMany(
        others.map((a) => ({
          subject: a.userId,
          relation: a.relation,
          objectType: "project",
          object: project._id,
          createdBy: user._id,
        }))
      );
    }
  } catch (e) {
    // Nothing of a half-made board survives: not the project, and not the grants that did land.
    // Both are tried whatever the other does, so one more failure cannot keep the project
    await Promise.allSettled([
      db.Grant.deleteMany({ objectType: "project", object: project._id }),
      db.Project.deleteOne({ _id: project._id }),
    ]);
    throw e;
  }

  const chosen = [
    ...(setup.pmEnabled ? ["PM agent: enabled at creation"] : []),
    ...(setup.repositoryUrl ? [`Repository: ${setup.repositoryUrl}`] : []),
  ];
  if (chosen.length > 0) {
    void logProjectAudit(db, String(project._id), user._id, "settings_updated", chosen);
  }

  const names = new Map(people.map((p) => [String(p._id), p.username]));
  for (const person of others) {
    auditAccess(db, String(project._id), user._id, names.get(person.userId) ?? person.userId, undefined, person.relation);
    void announceAccess(db, {
      projectId: String(project._id),
      recipientId: person.userId,
      actorId: String(user._id),
      actorName: user.fullName || user.username,
      relation: person.relation,
      added: true,
    });
  }

  const populated = await project.populate({ path: "createdBy", select: "username fullName", match: { organisation: db.organisation } });
  return NextResponse.json(sanitizeProjectSecrets(populated.toObject(), db.organisation), { status: 201 });
});
