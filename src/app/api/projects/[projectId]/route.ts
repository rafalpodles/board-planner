import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess, withProjectOwner, withProjectAccessOrWorker } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { Project } from "@/models/project";
import { parseProjectWorkerConfig } from "@/lib/project-worker-config";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { InstanceAuditAction } from "@/types";
import { Task } from "@/models/task";
import { Comment } from "@/models/comment";
import { ActivityLog } from "@/models/activityLog";
import { ProjectAuditLog } from "@/models/projectAuditLog";
import { Sprint } from "@/models/sprint";
import { Notification } from "@/models/notification";
import { PmMessage } from "@/models/pmMessage";
import { logProjectAudit } from "@/lib/projectAudit";
import { tokensInvalidatedByHostChange } from "@/lib/host-bound-secrets";
import { encryptSecret, isEncryptionConfigured } from "@/lib/encryption";
import { isAllowedMcpServerUrl } from "@/lib/url-validation";
import { validatePmConfig, isPmAvailable, mergeMcpServerTokens, sanitizeMcpServers } from "@/lib/pm/config";
import { sanitizeProjectSecrets } from "@/lib/project-secrets";
import { PROJECT_ICONS } from "@/types";
import { projectRepositoryUrl, repositoryProvider } from "@/lib/repository";

export const GET = withProjectAccessOrWorker(async (_request, { params, user }) => {
  await connectDB();
  const { projectId } = await params;

  const project = await Project.findById(projectId)
    .populate("createdBy", "username fullName");

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = sanitizeProjectSecrets(project.toObject());
  obj.repositoryUrl = projectRepositoryUrl(obj);
  obj.repositoryProvider = repositoryProvider(obj);
  delete obj.githubRepo;
  delete obj.gitlabRepo;
  if (obj.pm) obj.pm.mcpServers = sanitizeMcpServers(obj.pm.mcpServers);
  obj.pmAvailable = isPmAvailable();
  obj.canAdmin = await check(user, String(project._id), "admin");
  return NextResponse.json(obj);
});

export const PUT = withProjectOwner(async (request, { params, user }) => {
  await connectDB();
  const { projectId } = await params;
  const body = await request.json();

  const allowed = ["name", "description", "icon", "estimateFieldId", "repositoryUrl", "githubToken", "gitlabHost", "gitlabToken", "codaHost", "codaDocId", "codaTableId", "codaToken"];
  const updates: Record<string, unknown> = {};
  let workerAudit: PendingWorkerAudit[] = [];
  for (const field of allowed) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }
  if (body.key !== undefined) {
    return NextResponse.json(
      { error: "Project key cannot be changed" },
      { status: 403 }
    );
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

  if (updates.estimateFieldId !== undefined) {
    const id = updates.estimateFieldId;
    if (typeof id !== "string") {
      return NextResponse.json(
        { error: "estimateFieldId must be a string" },
        { status: 400 }
      );
    }
    if (id !== "") {
      const existing = await Project.findById(projectId).select("customFields");
      if (!existing) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      const field = (existing.customFields || []).find((f) => f._id.toString() === id);
      if (!field || field.fieldType !== "number" || field.archived) {
        return NextResponse.json(
          { error: "estimateFieldId must name a numeric field that is not archived" },
          { status: 400 }
        );
      }
    }
  }

  if (body.worker !== undefined) {
    if (user.role !== "admin") {
      return NextResponse.json(
        { error: "Only an instance admin can change worker settings" },
        { status: 403 }
      );
    }
    if (user.viaMachineCredential) {
      return NextResponse.json(
        { error: "Interactive admin session required to change worker settings" },
        { status: 403 }
      );
    }
    const existing = await Project.findById(projectId).select("worker key");
    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const parsed = parseProjectWorkerConfig(
      body.worker,
      existing.worker?.policyOverrides ?? [],
      (existing.worker?.policy ?? {}) as unknown as Record<string, unknown>
    );
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    Object.assign(updates, parsed.update);

    workerAudit = pendingWorkerAudit(
      existing as never,
      updates,
      existing.key || String(projectId)
    );
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
      const instanceFields = ["enabled", "model", "dailyTurnCap", "dailyTokenCap", "mcpServers"];
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
      body.pm.dailyTokenCap = existing.pm?.dailyTokenCap ?? 0;
    }
    const pmResult = validatePmConfig(body.pm);
    if (!pmResult.valid) {
      return NextResponse.json({ error: pmResult.error }, { status: 400 });
    }
    pmResult.value.lockedByInstance = existing.pm?.lockedByInstance ?? false;
    if (body.pm.mcpServers === undefined) {
      pmResult.value.mcpServers = existing.pm?.mcpServers ?? [];
    } else {
      const merged = mergeMcpServerTokens(pmResult.value.mcpServers ?? [], existing.pm?.mcpServers);
      if (!merged.valid) {
        return NextResponse.json({ error: merged.error }, { status: 400 });
      }
      pmResult.value.mcpServers = merged.value;
    }
    if (body.pm.autonomy === undefined && existing.pm?.autonomy) {
      pmResult.value.autonomy = existing.pm.autonomy;
    } else if (pmResult.value.autonomy) {
      pmResult.value.autonomy.lastReviewSlot = existing.pm?.autonomy?.lastReviewSlot ?? "";
    }
    updates.pm = pmResult.value;
  }

  if (updates.gitlabHost !== undefined) {
    const host = String(updates.gitlabHost).trim().replace(/\/+$/, "");
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

  const clearedByHostChange: string[] = [];
  if (updates.gitlabHost !== undefined || updates.codaHost !== undefined) {
    const before = await Project.findById(
      projectId,
      "gitlabHost gitlabToken codaHost codaToken"
    ).lean();

    for (const pair of tokensInvalidatedByHostChange(updates, before as never)) {
      updates[pair.token] = "";
      clearedByHostChange.push(pair.label);
    }
  }

  const incomingTokens = ["githubToken", "gitlabToken", "codaToken"] as const;
  const storingAToken = incomingTokens.some(
    (field) => typeof updates[field] === "string" && updates[field]
  );
  if (storingAToken && !isEncryptionConfigured()) {
    return NextResponse.json(
      {
        error:
          "ENCRYPTION_KEY is not configured on this server, so integration tokens cannot be stored. Set it to 32 bytes of hex or base64 and try again.",
      },
      { status: 400 }
    );
  }
  for (const field of incomingTokens) {
    if (typeof updates[field] === "string" && updates[field]) {
      updates[field] = encryptSecret(updates[field] as string);
    }
  }

  const project = await Project.findByIdAndUpdate(projectId, updates, {
    returnDocument: "after",
  }).populate("createdBy", "username fullName");

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  for (const entry of workerAudit) {
    void logInstanceAudit({ ...entry, user: String(user._id), actorUsername: user.username });
  }

  const changedFields = Object.keys(updates)
    .filter((f) => f !== "githubToken" && f !== "gitlabToken")
    .join(", ");
  const auditDetail = updates.githubToken !== undefined
    ? `Changed: ${changedFields ? changedFields + ", " : ""}GitHub token`
    : `Changed: ${changedFields}`;
  logProjectAudit(projectId, user._id, "settings_updated", auditDetail);

  if (clearedByHostChange.length > 0) {
    logProjectAudit(
      projectId,
      user._id,
      "settings_updated",
      `Integration host changed — stored ${clearedByHostChange.join(" and ")} token cleared, must be re-entered`
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = sanitizeProjectSecrets(project.toObject());
  obj.repositoryUrl = projectRepositoryUrl(obj);
  obj.repositoryProvider = repositoryProvider(obj);
  delete obj.githubRepo;
  delete obj.gitlabRepo;
  if (obj.pm) obj.pm.mcpServers = sanitizeMcpServers(obj.pm.mcpServers);
  obj.pmAvailable = isPmAvailable();
  obj.canAdmin = await check(user, String(project._id), "admin");
  return NextResponse.json(obj);
});

export const DELETE = withProjectOwner(async (_request, { params }) => {
  await connectDB();
  const { projectId } = await params;

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const taskIds = await Task.find({ project: projectId }).distinct("_id");
  await Promise.all([
    Comment.deleteMany({ task: { $in: taskIds } }),
    ActivityLog.deleteMany({ task: { $in: taskIds } }),
  ]);

  await Task.deleteMany({ project: projectId });
  await Sprint.deleteMany({ project: projectId });
  await Notification.deleteMany({ project: projectId });
  await PmMessage.deleteMany({ project: projectId });

  await ProjectAuditLog.deleteMany({ project: projectId });
  await Project.findByIdAndDelete(projectId);

  return NextResponse.json({ message: "Project deleted" });
});

type PendingWorkerAudit = { action: InstanceAuditAction; target: string; detail?: string };

function pendingWorkerAudit(
  existing: { worker?: { enabled?: boolean; policy?: { autoMerge?: boolean; reviewGate?: boolean } } },
  updates: Record<string, unknown>,
  target: string
): PendingWorkerAudit[] {
  const entries: PendingWorkerAudit[] = [];

  const nowEnabled = updates["worker.enabled"];
  if (typeof nowEnabled === "boolean" && nowEnabled !== !!existing.worker?.enabled) {
    entries.push({
      action: nowEnabled ? "project_workers_enabled" : "project_workers_disabled",
      target,
    });
  }

  const changed: string[] = [];
  for (const field of ["autoMerge", "reviewGate"] as const) {
    const next = updates[`worker.policy.${field}`];
    if (typeof next === "boolean" && next !== !!existing.worker?.policy?.[field]) {
      changed.push(`${field} ${next ? "on" : "off"}`);
    }
  }
  if (changed.length > 0) {
    entries.push({
      action: "project_worker_policy_changed",
      target,
      detail: changed.join(", "),
    });
  }

  return entries;
}
