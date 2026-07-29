import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess, withProjectAdmin, withAdmin, canAdminProject } from "@/lib/middleware";
import { Project } from "@/models/project";
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
import { PROJECT_ICONS } from "@/types";

export const GET = withProjectAccess(async (_request, { params, user }) => {
  await connectDB();
  const { projectId } = await params;

  const project = await Project.findById(projectId)
    .populate("owner", "username fullName")
    .populate("admins", "username fullName");

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Strip token, expose only boolean flag
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = project.toObject();
  obj.githubTokenSet = !!obj.githubToken;
  delete obj.githubToken;
  obj.gitlabTokenSet = !!obj.gitlabToken;
  delete obj.gitlabToken;
  if (obj.pm) obj.pm.mcpServers = sanitizeMcpServers(obj.pm.mcpServers);
  obj.pmAvailable = isPmAvailable();
  obj.canAdmin = canAdminProject(user, project);
  return NextResponse.json(obj);
});

export const PUT = withProjectAdmin(async (request, { params, user }) => {
  await connectDB();
  const { projectId } = await params;
  const body = await request.json();

  const allowed = ["name", "description", "key", "icon", "githubRepo", "githubToken", "gitlabRepo", "gitlabHost", "gitlabToken"];
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
      pmResult.value.autonomy.lastDailyReviewDay =
        existing.pm?.autonomy?.lastDailyReviewDay ?? "";
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

  // Encrypt the GitHub/GitLab tokens at rest (no-op if ENCRYPTION_KEY is unset).
  if (typeof updates.githubToken === "string" && updates.githubToken) {
    updates.githubToken = encryptSecret(updates.githubToken);
  }
  if (typeof updates.gitlabToken === "string" && updates.gitlabToken) {
    updates.gitlabToken = encryptSecret(updates.gitlabToken);
  }

  const project = await Project.findByIdAndUpdate(projectId, updates, {
    new: true,
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

  // Strip token from response
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = project.toObject();
  obj.githubTokenSet = !!obj.githubToken;
  delete obj.githubToken;
  obj.gitlabTokenSet = !!obj.gitlabToken;
  delete obj.gitlabToken;
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
