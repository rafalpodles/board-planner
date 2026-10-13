import type { ScopedDb } from "@/lib/db-scope";

// A client registered anonymously stays unused until a person approves it at /oauth/authorize. Such
// a row carries `expiresAt`; approving clears it, and a row from before this existed has none, so it
// is never reaped or evicted (a live connection is never what a flood can take away).
export const UNUSED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_UNUSED_CLIENTS = 1000;
// A registration this young may be a person at the consent screen right now; evicting it would
// break their flow with a page and no way for the MCP host to register again by itself
export const UNUSED_CLIENT_GRACE_MS = 15 * 60 * 1000;

const unusedClients = () => ({ expiresAt: { $gt: new Date(0) } });

export const unusedClientExpiry = (now = Date.now()) => new Date(now + UNUSED_CLIENT_TTL_MS);

/**
 * Registration is anonymous and each row lives for the TTL, so what bounds the collection when no
 * caller can be told apart is a ceiling on the rows nobody has approved. Past it the oldest of those
 * go, as pending enrolments do — but never one younger than the grace period, which a flood must
 * not be able to take from somebody mid-flow. When there are not enough old ones, false: the
 * registration is refused (429), which is no worse than the shared bucket it replaces and costs an
 * attacker five times the requests. An approved client is never touched.
 *
 * Ordered by `expiresAt`, which is `createdAt` plus the TTL, so the compound index serves it.
 */
export async function makeRoomForClient(db: ScopedDb, now = Date.now()): Promise<boolean> {
  const unused = await db.OAuthClient.countDocuments(unusedClients());
  if (unused < MAX_UNUSED_CLIENTS) return true;
  const needed = unused - MAX_UNUSED_CLIENTS + 1;
  const evictable = () => ({
    expiresAt: { $gt: new Date(0), $lte: new Date(now + UNUSED_CLIENT_TTL_MS - UNUSED_CLIENT_GRACE_MS) },
  });
  const surplus = await db.OAuthClient.find(evictable())
    .sort({ expiresAt: 1 })
    .limit(needed)
    .select("_id")
    .lean();
  // The filter again, not the ids alone: a client approved between the find and the delete must
  // keep its row
  if (surplus.length > 0) {
    await db.OAuthClient.deleteMany({ ...evictable(), _id: { $in: surplus.map((row) => row._id) } });
  }
  return surplus.length >= needed;
}

/** False when no such client is left: it was evicted or deleted since the person was shown it. */
export async function markClientUsed(db: ScopedDb, clientId: string): Promise<boolean> {
  const result = await db.OAuthClient.updateOne({ clientId }, { $unset: { expiresAt: 1 } });
  return result.matchedCount > 0;
}
