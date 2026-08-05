import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth, withAdmin } from "@/lib/middleware";
import { check, accessibleProjectIds } from "@/lib/grants";
import { Project } from "@/models/project";
import { legacyFieldSeeds } from "@/lib/legacy-fields";
import { Task } from "@/models/task";
import { Sprint } from "@/models/sprint";
import { sanitizeMcpServers } from "@/lib/pm/config";
import { sanitizeProjectSecrets } from "@/lib/project-secrets";

export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  const accessibleIds = await accessibleProjectIds(user);
  const filter = accessibleIds === null ? {} : { _id: { $in: accessibleIds } };

  // Manual order first; anything never dragged keeps its default 0 and falls
  // back to newest-first, which is the order this list had before CP-180
  const projects = await Project.find(filter)
    .populate("owner", "username fullName")
    .sort({ sortOrder: 1, createdAt: -1 });

  // The sidebar renders on every route, so its per-project badges have to come
  // from this one request. Two flat queries joined in memory rather than a
  // $lookup with an inline pipeline, which needs MongoDB 5.0.
  const ids = projects.map((p) => p._id);
  const [taskStats, activeSprints] = await Promise.all([
    Task.aggregate([
      { $match: { project: { $in: ids } } },
      {
        $group: {
          _id: "$project",
          taskCount: { $sum: 1 },
        },
      },
    ]),
    Sprint.find({ project: { $in: ids }, status: "active" }).select("project").lean(),
  ]);

  const statsByProject = new Map(taskStats.map((s) => [String(s._id), s]));
  const withActiveSprint = new Set(activeSprints.map((s) => String(s.project)));

  const sanitized = await Promise.all(projects.map(async (p) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: any = sanitizeProjectSecrets(p.toObject());
    if (obj.pm) obj.pm.mcpServers = sanitizeMcpServers(obj.pm.mcpServers);

    const stats = statsByProject.get(String(p._id));
    obj.taskCount = stats?.taskCount ?? 0;
    obj.hasActiveSprint = withActiveSprint.has(String(p._id));
    obj.canAdmin = await check(user, String(p._id), "admin");
    return obj;
  }));
  return NextResponse.json(sanitized);
});

export const POST = withAdmin(async (request, { user }) => {
  await connectDB();
  const body = await request.json();
  const { name, key, description } = body;

  if (!name || !key) {
    return NextResponse.json(
      { error: "name and key are required" },
      { status: 400 }
    );
  }

  const project = await Project.create({
    name,
    key,
    description: description || "",
    owner: user._id,
    // A fresh project looks like a fresh project always did — the difference is
    // that all three are now editable and removable (CP-213)
    customFields: legacyFieldSeeds({}),
  });

  const populated = await project.populate("owner", "username fullName");
  return NextResponse.json(sanitizeProjectSecrets(populated.toObject()), { status: 201 });
});
