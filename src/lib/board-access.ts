import type { ScopedDb } from "@/lib/db-scope";
import { createNotifications } from "@/lib/in-app-notifications";
import { logProjectAudit } from "@/lib/projectAudit";
import type { GrantRelation } from "@/types";

export function auditAccess(
  db: ScopedDb,
  projectId: string,
  actorId: unknown,
  username: string,
  from: GrantRelation | undefined,
  to: GrantRelation | undefined,
  takenOver = false
): void {
  const action = !from ? "member_added" : !to ? "member_removed" : "member_role_changed";
  void logProjectAudit(
    db,
    projectId,
    String(actorId),
    action,
    `${username}: ${from ?? "no access"} → ${to ?? "no access"}${takenOver ? " (set by hand; the identity provider's group had set it)" : ""}`
  );
}

export async function announceAccess(db: ScopedDb, change: {
  projectId: string;
  recipientId: string;
  actorId: string;
  actorName: string;
  relation: GrantRelation;
  added: boolean;
}): Promise<void> {
  try {
    const project = await db.Project.findById(change.projectId).select("name key").lean();
    const board = project?.name ?? "a board";
    const role = change.relation === "owner" ? "an owner" : "a member";
    await createNotifications(db, {
      type: "board_access",
      projectId: change.projectId,
      actorId: change.actorId,
      recipientIds: [change.recipientId],
      title: change.added
        ? `${change.actorName} added you to ${board} as ${role}`
        : `${change.actorName} made you ${role} of ${board}`,
      email: project
        ? {
            kicker: change.added ? "Added to a board" : "Your role changed",
            taskKey: project.key,
            taskTitle: project.name,
            taskMeta: `You are ${role} of this board`,
            projectRef: project.key,
          }
        : undefined,
    });
  } catch (err) {
    console.error("Failed to announce a board access change:", err);
  }
}
