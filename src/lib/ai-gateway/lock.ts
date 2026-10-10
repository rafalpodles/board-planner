import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Organisation } from "@/models/organisation";

/**
 * Switches off, or back on, what an organisation may spend of the operator's AI key. Its own key is not touched: the lock is
 * about the operator's spend. Refused for an organisation that is gone or being deleted.
 */
export async function setAiLocked(organisationId: string, locked: boolean, reason = ""): Promise<"ok" | "not_found"> {
  const hex = organisationId.toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(hex)) return "not_found";
  await connectDB();
  const live = { _id: new Types.ObjectId(hex), deletedAt: null, deletingAt: null };
  const changed = await Organisation.updateOne(
    live,
    locked ? { $set: { aiLockedAt: new Date(), aiLockedReason: reason } } : { $set: { aiLockedAt: null, aiLockedReason: "" } }
  );
  return changed.matchedCount > 0 ? "ok" : "not_found";
}
