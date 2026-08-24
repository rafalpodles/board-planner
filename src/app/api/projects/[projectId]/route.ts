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
  // One repository field, resolved here so no consumer has to know the legacy pair still exists
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
    // Instance-admin only: enabling a project for workers commits somebody's machine to running
    // agent-written code, which is not a project admin's call to make.
    if (user.role !== "admin") {
      return NextResponse.json(
        { error: "Only an instance admin can change worker settings" },
        { status: 403 }
      );
    }
    // Enabling a project for workers, or turning on autoMerge, commits somebody's machine to
    // running agent-written code. The device-enrolment route performing the same enable is
    // already gated this way; an unscoped admin API token used to walk past this one (BP-306).
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
      // The cross-field rule is judged on the resulting state, so it needs what is stored
      (existing.worker?.policy ?? {}) as unknown as Record<string, unknown>
    );
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    Object.assign(updates, parsed.update);

    // Decided here, where the old values are in hand, and written after the update lands. Firing
    // it here would record decisions that never happened: five later branches still return 400,
    // and this handler is one request — a rejected gitlabHost would leave a row saying a project
    // had been committed to workers.
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

  // A stored token is issued for one host. It is deliberately unreadable — sanitizeProjectSecrets
  // strips it from every response — but the host it is sent to was an ordinary editable field, so
  // repointing it and triggering a sync delivered the cleartext credential to an address of the
  // caller's choosing. The MCP OAuth branch in mergeMcpServerTokens already draws this line and
  // says why: the credential "was issued for a different resource" (BP-315).
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
    void logInstanceAudit({ ...entry, user: String(user._id) });
  }

  const changedFields = Object.keys(updates)
    .filter((f) => f !== "githubToken" && f !== "gitlabToken")
    .join(", ");
  const auditDetail = updates.githubToken !== undefined
    ? `Changed: ${changedFields ? changedFields + ", " : ""}GitHub token`
    : `Changed: ${changedFields}`;
  logProjectAudit(projectId, user._id, "settings_updated", auditDetail);

  // Its own entry, not folded into the "Changed: …" list. Somebody reading the trail after a
  // suspected leak needs to see that a credential's destination moved, and when.
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
  // One repository field, resolved here so no consumer has to know the legacy pair still exists
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

type PendingWorkerAudit = { action: InstanceAuditAction; target: string; detail?: string };

// Decided from the values already stored, because the update is a dotted patch: a field the request
// never mentioned is not a change, and one carrying the value it already had is not either.
//
// A single verb with a detail for the policy pair, unlike the fleet verbs: "who stopped this
// machine" wants an answer in the action column, while "what did this project's rules become"
// is a question about the values, and they belong together on one row.
function pendingWorkerAudit(
  existing: { worker?: { enabled?: boolean; policy?: { autoMerge?: boolean; reviewGate?: boolean } } },
  updates: Record<string, unknown>,
  target: string
): PendingWorkerAudit[] {
  const entries: PendingWorkerAudit[] = [];

  const nowEnabled = updates["worker.enabled"];
  if (typeof nowEnabled === "boolean" && nowEnabled !== !!existing.worker?.enabled) {
    // Instance-level, not project-level: this commits somebody's machine to running agent-written
    // code, and the project audit log is read by project admins who cannot make that decision.
    entries.push({
      action: nowEnabled ? "project_workers_enabled" : "project_workers_disabled",
      target,
    });
  }

  // Only the safety pair. The rest of the policy describes how work is done and stays in the
  // project's own log; these two decide whether anything reaches a base branch unreviewed.
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
