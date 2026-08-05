import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess, withProjectAdmin, withAdmin, canAdminProject, withProjectAccessOrWorker } from "@/lib/middleware";
import { Project } from "@/models/project";
import { parseProjectWorkerConfig } from "@/lib/project-worker-config";
import { User } from "@/models/user";
import { Task } from "@/models/task";
import { Comment } from "@/models/comment";
import { ActivityLog } from "@/models/activityLog";
import { ProjectAuditLog } from "@/models/projectAuditLog";
import { Sprint } from "@/models/sprint";
import { Notification } from "@/models/notification";
import { PmMessage } from "@/models/pmMessage";
import { logProjectAudit } from "@/lib/projectAudit";
import { encryptSecret } from "@/lib/encryption";
import { isAllowedMcpServerUrl } from "@/lib/url-validation";
import { validatePmConfig, isPmAvailable, mergeMcpServerTokens, sanitizeMcpServers } from "@/lib/pm/config";
import { sanitizeProjectSecrets } from "@/lib/project-secrets";
import { PROJECT_ICONS } from "@/types";
import { projectRepositoryUrl, repositoryProvider } from "@/lib/repository";

export const GET = withProjectAccessOrWorker(async (_request, { params, user }) => {
  await connectDB();
  const { projectId } = await params;

  const project = await Project.findById(projectId)
    .populate("owner", "username fullName")
    .populate("admins", "username fullName");

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = sanitizeProjectSecrets(project.toObject());
  // One repository field, resolved here so no consumer has to know the legacy pair still exists
  obj.repositoryUrl = projectRepositoryUrl(obj);
  obj.repositoryProvider = repositoryProvider(obj);
  delete obj.githubRepo;
  delete obj.gitlabRepo;
  if (obj.pm) obj.pm.mcpServers = sanitizeMcpServers(obj.pm.mcpServers);
  obj.pmAvailable = isPmAvailable();
  obj.canAdmin = canAdminProject(user, project);
  return NextResponse.json(obj);
});

export const PUT = withProjectAdmin(async (request, { params, user }) => {
  await connectDB();
  const { projectId } = await params;
  const body = await request.json();

  const allowed = ["name", "description", "key", "icon", "repositoryUrl", "githubToken", "gitlabHost", "gitlabToken", "codaHost", "codaDocId", "codaTableId", "codaToken"];
  const updates: Record<string, unknown> = {};
  for (const field of allowed) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  if (updates.icon !== undefined) {
    const icon = updates.icon;
    if (typeof icon !== "string" || (icon !== "" && !PROJECT_ICONS.includes(icon))) {
      return NextResponse.json(
        { error: "icon must be empty or one of the supported project icons" },
        { status: 400 }
      );
    }
  }

  if (body.admins !== undefined) {
    if (
      !Array.isArray(body.admins) ||
      body.admins.some((id: unknown) => typeof id !== "string" || !isValidObjectId(id))
    ) {
      return NextResponse.json(
        { error: "admins must be an array of user ids" },
        { status: 400 }
      );
    }
    const current = await Project.findById(projectId).select("owner");
    if (!current) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const ownerId = current.owner.toString();
    const ids = [...new Set(body.admins as string[])].filter((id) => id !== ownerId);
    const candidates = await User.find({ _id: { $in: ids } }).select("role allowedProjects");
    const eligible = new Set(
      candidates
        .filter(
          (u) =>
            u.role === "admin" ||
            (u.allowedProjects || []).some((p) => p.toString() === projectId)
        )
        .map((u) => u._id.toString())
    );
    const rejected = ids.filter((id) => !eligible.has(id));
    if (rejected.length > 0) {
      return NextResponse.json(
        { error: "Only users with access to this project can be project admins" },
        { status: 400 }
      );
    }
    updates.admins = ids;
  }

  if (body.worker !== undefined) {
    // Instance-admin only: enabling a project for workers commits somebody's machine to running
    // agent-written code, which is not a project admin's call to make.
    if (user.role !== "admin") {
      return NextResponse.json(
        { error: "Only an instance admin can change worker settings" },
        { status: 403 }
      );
    }
    const existing = await Project.findById(projectId).select("worker");
    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const parsed = parseProjectWorkerConfig(
      body.worker,
      existing.worker?.policyOverrides ?? [],
      // The cross-field rule is judged on the resulting state, so it needs what is stored
      (existing.worker?.policy ?? {}) as unknown as Record<string, unknown>
    );
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    Object.assign(updates, parsed.update);
  }

  if (body.pm !== undefined) {
    if (typeof body.pm !== "object" || body.pm === null || Array.isArray(body.pm)) {
      return NextResponse.json({ error: "pm must be an object" }, { status: 400 });
    }
    const existing = await Project.findById(projectId).select("pm");
    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    if (user.role !== "admin") {
      const instanceFields = ["enabled", "model", "dailyTurnCap", "mcpServers"];
      const rejected = instanceFields.filter((f) => body.pm[f] !== undefined);
      if (rejected.length > 0) {
        return NextResponse.json(
          { error: `Only an instance admin can change PM ${rejected.join(", ")}` },
          { status: 403 }
        );
      }
      body.pm.enabled = existing.pm?.enabled ?? false;
      body.pm.model = existing.pm?.model ?? "";
      body.pm.dailyTurnCap = existing.pm?.dailyTurnCap ?? 0;
    }
    const pmResult = validatePmConfig(body.pm);
    if (!pmResult.valid) {
      return NextResponse.json({ error: pmResult.error }, { status: 400 });
    }
    // validatePmConfig rebuilds pm from a whitelist, so the instance lock would be
    // dropped by any project-side save. It is settable only from the admin console.
    pmResult.value.lockedByInstance = existing.pm?.lockedByInstance ?? false;
    if (body.pm.mcpServers === undefined) {
      // Clients unaware of mcpServers must not wipe the configured list
      pmResult.value.mcpServers = existing.pm?.mcpServers ?? [];
    } else {
      const merged = mergeMcpServerTokens(pmResult.value.mcpServers ?? [], existing.pm?.mcpServers);
      if (!merged.valid) {
        return NextResponse.json({ error: merged.error }, { status: 400 });
      }
      pmResult.value.mcpServers = merged.value;
    }
    if (body.pm.autonomy === undefined && existing.pm?.autonomy) {
      // Clients unaware of autonomy must not silently disable the scheduled review
      pmResult.value.autonomy = existing.pm.autonomy;
    } else if (pmResult.value.autonomy) {
      pmResult.value.autonomy.lastReviewSlot = existing.pm?.autonomy?.lastReviewSlot ?? "";
    }
    updates.pm = pmResult.value;
  }

  if (updates.gitlabHost !== undefined) {
    const host = String(updates.gitlabHost).trim().replace(/\/+$/, "");
    // Same rules as MCP server URLs: public https, localhost allowed outside production
    if (host && !isAllowedMcpServerUrl(host)) {
      return NextResponse.json(
        { error: "gitlabHost must be a public https URL" },
        { status: 400 }
      );
    }
    updates.gitlabHost = host || "https://gitlab.com";
  }

  if (updates.codaHost !== undefined) {
    const host = String(updates.codaHost).trim().replace(/\/+$/, "");
    if (host && !isAllowedMcpServerUrl(host)) {
      return NextResponse.json(
        { error: "codaHost must be a public https URL" },
        { status: 400 }
      );
    }
    updates.codaHost = host || "https://coda.io";
  }

  // Encrypt the GitHub/GitLab tokens at rest (no-op if ENCRYPTION_KEY is unset).
  if (typeof updates.githubToken === "string" && updates.githubToken) {
    updates.githubToken = encryptSecret(updates.githubToken);
  }
  if (typeof updates.gitlabToken === "string" && updates.gitlabToken) {
    updates.gitlabToken = encryptSecret(updates.gitlabToken);
  }
  if (typeof updates.codaToken === "string" && updates.codaToken) {
    updates.codaToken = encryptSecret(updates.codaToken);
  }

  const project = await Project.findByIdAndUpdate(projectId, updates, {
    returnDocument: "after",
  })
    .populate("owner", "username fullName")
    .populate("admins", "username fullName");

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const changedFields = Object.keys(updates)
    .filter((f) => f !== "githubToken" && f !== "gitlabToken")
    .join(", ");
  const auditDetail = updates.githubToken !== undefined
    ? `Changed: ${changedFields ? changedFields + ", " : ""}GitHub token`
    : `Changed: ${changedFields}`;
  logProjectAudit(projectId, user._id, "settings_updated", auditDetail);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = sanitizeProjectSecrets(project.toObject());
  // One repository field, resolved here so no consumer has to know the legacy pair still exists
  obj.repositoryUrl = projectRepositoryUrl(obj);
  obj.repositoryProvider = repositoryProvider(obj);
  delete obj.githubRepo;
  delete obj.gitlabRepo;
  if (obj.pm) obj.pm.mcpServers = sanitizeMcpServers(obj.pm.mcpServers);
  obj.pmAvailable = isPmAvailable();
  obj.canAdmin = canAdminProject(user, project);
  return NextResponse.json(obj);
});

export const DELETE = withAdmin(async (_request, { params }) => {
  await connectDB();
  const { projectId } = await params;

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Delete all comments and activity logs on tasks in this project
  const taskIds = await Task.find({ project: projectId }).distinct("_id");
  await Promise.all([
    Comment.deleteMany({ task: { $in: taskIds } }),
    ActivityLog.deleteMany({ task: { $in: taskIds } }),
  ]);

  // Delete all tasks, sprints, notifications in this project
  await Task.deleteMany({ project: projectId });
  await Sprint.deleteMany({ project: projectId });
  await Notification.deleteMany({ project: projectId });
  await PmMessage.deleteMany({ project: projectId });

  // Delete project audit logs and the project itself
  await ProjectAuditLog.deleteMany({ project: projectId });
  await Project.findByIdAndDelete(projectId);

  return NextResponse.json({ message: "Project deleted" });
});
