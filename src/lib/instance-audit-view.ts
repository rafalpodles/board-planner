import { ApiInstanceAuditLog, InstanceAuditAction } from "@/types";

// How the instance audit log reads. Past tense, because every row is something that already
// happened, and one column: the actions are deliberately separate verbs (see the comment above
// INSTANCE_AUDIT_ACTIONS) so nobody scanning the list has to read the next column to find out what
// happened.
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
  // Only the safety pair reaches this log — the rest of a project's worker policy describes how
  // work is done and stays in that project's own log
  project_worker_policy_changed: "Merge safety changed for project",
  user_password_reset: "Password set by an admin",
  user_email_changed: "Address changed by an admin",
  user_email_changed_self: "Address changed by the account itself",
  user_password_reset_by_email: "Password reset by email",
  user_full_name_changed_self: "Name changed by the account itself",
  user_created: "Account created",
  user_deleted: "Account deleted",
  // The direction is in `detail`, the way the address change carries old → new
  user_role_changed: "Role changed",
};

// The one action whose verb lives in `detail` rather than in its name, because a single endpoint
// carries all three. Reading it back out is what keeps this row obeying the same rule as the rest:
// "Worker told to stop" and "Worker told to pause" are different sentences, where one shared label
// would have made them the same row with a footnote (BP-531).
const COMMAND_LABELS: Record<string, string> = {
  pause: "Worker told to pause",
  resume: "Worker told to resume",
  stop: "Worker told to stop",
};

const COMMAND_SENT: InstanceAuditAction = "worker_command_sent";

// A command this build does not know is still a command, and saying so beats the identifier
const UNKNOWN_COMMAND = "Command sent to a worker";

// The actions worth spotting at a glance: they stop a machine, hand out the credential that lets a
// new one join, or hand somebody a way into another person's account.
const NOTABLE = new Set<InstanceAuditAction>([
  "worker_locked",
  "enrolment_token_minted",
  "enrolment_token_spent",
  "user_password_reset",
  "user_email_changed",
  // Moving one's own recovery address is worth spotting for the same reason as the admin doing it:
  // it decides where the next reset link lands, and it signs nobody out
  "user_email_changed_self",
  "user_password_reset_by_email",
  // What an account may do, and whether it exists at all. Creation is routine and stays quiet;
  // these two are the ones somebody scanning the log is looking for.
  "user_role_changed",
  "user_deleted",
]);

type Entry = Pick<ApiInstanceAuditLog, "action" | "detail">;

/**
 * Who wrote the row, as this log can still name them.
 *
 * The stored username first, because the reference beside it resolves to null the moment that
 * account is deleted — which used to rewrite every row an administrator had written as "system",
 * the word reserved for a caller with no session at all (BP-539). The reference second, for the
 * rows written before that field existed. "system" last, which is then the honest answer: either a
 * machine wrote it, or it predates the fix and its author is gone.
 */
export function auditActor(
  log: Pick<ApiInstanceAuditLog, "actorUsername" | "user">
): string {
  return log.actorUsername || log.user?.username || "system";
}

export function auditActionLabel(log: Entry): string {
  if (log.action === COMMAND_SENT) return COMMAND_LABELS[log.detail] ?? UNKNOWN_COMMAND;
  // The fallback is for an action this build has never heard of — a row written by a newer
  // deployment against the same database. Every action this build declares has a label above, and
  // instance-audit-view.test.ts fails when one does not.
  return LABELS[log.action] ?? log.action.replace(/_/g, " ");
}

/**
 * Whether the row is drawn as something to notice.
 *
 * A predicate rather than a set membership because of the commands: pausing and stopping take work
 * off a machine exactly as the kill switch does, and resuming gives it back. One entry for all
 * three would either paint an ordinary resume red or leave a stop as quiet as a rename — and a stop
 * going unnoticed is the failure this log exists to prevent.
 */
export function auditIsNotable(log: Entry): boolean {
  if (log.action === COMMAND_SENT) return log.detail !== "resume";
  return NOTABLE.has(log.action);
}
