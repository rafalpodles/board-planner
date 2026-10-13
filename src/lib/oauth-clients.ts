import type { ScopedDb } from "@/lib/db-scope";

// A client registered anonymously stays unused until a person approves it at /oauth/authorize. Such
// a row carries `expiresAt`; approving clears it, and a row from before this existed has none, so it
// is never reaped or evicted (a live connection is never what a flood can take away).
export const UNUSED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_UNUSED_CLIENTS = 1000;

const unusedClients = () => ({ expiresAt: { $gt: new Date(0) } });

export const unusedClientExpiry = (now = Date.now()) => new Date(now + UNUSED_CLIENT_TTL_MS);

/**
 * Registration is anonymous and each row lives for the TTL, so what bounds the collection when no
 * caller can be told apart is a ceiling on the rows nobody has approved: past it the oldest of
 * those go, as pending enrolments do. A flood can still age out a client registered a moment ago
 * and not yet approved, and the host registers again; an approved client is never touched.
 */
export async function makeRoomForClient(db: ScopedDb): Promise<void> {
  const unused = await db.OAuthClient.countDocuments(unusedClients());
  if (unused < MAX_UNUSED_CLIENTS) return;
  const surplus = await db.OAuthClient.find(unusedClients())
    .sort({ createdAt: 1 })
    .limit(unused - MAX_UNUSED_CLIENTS + 1)
    .select("_id")
    .lean();
  // Unused again in the filter, not the ids alone: a client approved between the find and the
  // delete must keep its row
  await db.OAuthClient.deleteMany({ ...unusedClients(), _id: { $in: surplus.map((row) => row._id) } });
}

export async function markClientUsed(db: ScopedDb, clientId: string): Promise<void> {
  await db.OAuthClient.updateOne({ clientId }, { $unset: { expiresAt: 1 } });
}
