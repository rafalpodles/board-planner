import { ApiInstanceAuditLog, InstanceAuditAction } from "@/types";

const LABELS: Partial<Record<InstanceAuditAction, string>> = {
  worker_locked: "Kill switch on",
  worker_unlocked: "Kill switch cleared",
  worker_enabled: "Worker enabled",
  worker_disabled: "Worker disabled",
  worker_renamed: "Worker renamed",
  worker_released: "Worker released from its owner",
  worker_poll_interval_changed: "Poll interval changed",
  enrolment_token_minted: "Enrolment token minted",
  enrolment_token_spent: "Enrolment token spent",
  project_workers_enabled: "Workers enabled for project",
  project_workers_disabled: "Workers disabled for project",
  project_worker_policy_changed: "Merge safety changed for project",
  user_password_reset: "Password set by an admin",
  user_email_changed: "Address changed by an admin",
  user_email_changed_self: "Address changed by the account itself",
  user_password_reset_by_email: "Password reset by email",
  user_full_name_changed_self: "Name changed by the account itself",
  user_created: "Account created",
  user_deleted: "Account deleted",
  user_role_changed: "Role changed",
};

const COMMAND_LABELS: Record<string, string> = {
  pause: "Worker told to pause",
  resume: "Worker told to resume",
  stop: "Worker told to stop",
};

const COMMAND_SENT: InstanceAuditAction = "worker_command_sent";

const UNKNOWN_COMMAND = "Command sent to a worker";

const NOTABLE = new Set<InstanceAuditAction>([
  "worker_locked",
  "enrolment_token_minted",
  "enrolment_token_spent",
  "user_password_reset",
  "user_email_changed",
  "user_email_changed_self",
  "user_password_reset_by_email",
  "user_role_changed",
  "user_deleted",
]);

type Entry = Pick<ApiInstanceAuditLog, "action" | "detail">;

export function auditActor(
  log: Pick<ApiInstanceAuditLog, "actorUsername" | "user">
): string {
  return log.actorUsername || log.user?.username || "system";
}

export function auditActionLabel(log: Entry): string {
  if (log.action === COMMAND_SENT) return COMMAND_LABELS[log.detail] ?? UNKNOWN_COMMAND;
  return LABELS[log.action] ?? log.action.replace(/_/g, " ");
}

export function auditIsNotable(log: Entry): boolean {
  if (log.action === COMMAND_SENT) return log.detail !== "resume";
  return NOTABLE.has(log.action);
}
