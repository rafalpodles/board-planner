import type { Types } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";

export type ConnectionProvider = "github" | "gitlab";

const FIELD = { github: "githubConnection", gitlab: "gitlabConnection" } as const;

/** True only for the write that moved the project into the rejected state, so it is reported once. */
export async function recordTokenRejected(
  db: ScopedDb,
  projectId: Types.ObjectId | string,
  provider: ConnectionProvider,
  now = new Date()
): Promise<boolean> {
  const field = FIELD[provider];
  const result = await db.Project.updateOne(
    { _id: projectId, [`${field}.rejectedAt`]: null },
    { $set: { [`${field}.rejectedAt`]: now } }
  );
  return result.modifiedCount === 1;
}

export async function recordSyncSucceeded(
  db: ScopedDb,
  projectId: Types.ObjectId | string,
  provider: ConnectionProvider,
  counts: { prsLinked: number; tasksLinked: number },
  now = new Date()
): Promise<void> {
  const field = FIELD[provider];
  await db.Project.updateOne(
    { _id: projectId },
    {
      $set: {
        [`${field}.rejectedAt`]: null,
        [`${field}.lastSyncAt`]: now,
        [`${field}.lastSyncLinked`]: counts.prsLinked,
        [`${field}.lastSyncTasks`]: counts.tasksLinked,
      },
    }
  );
}

/** A new token starts a new connection: nothing the old one earned or lost carries over. */
export function freshConnection(identity: { login: string; expiresAt: Date | null } = { login: "", expiresAt: null }) {
  return { rejectedAt: null, lastSyncAt: null, lastSyncLinked: 0, lastSyncTasks: 0, ...identity };
}

export function isRejected(connection: { rejectedAt?: Date | string | null } | null | undefined): boolean {
  return !!connection?.rejectedAt;
}
