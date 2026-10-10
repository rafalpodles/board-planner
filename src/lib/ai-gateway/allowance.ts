import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { scoped } from "@/lib/db-scope";
import { Organisation, type IOrganisation } from "@/models/organisation";
import { counterKindOf } from "./budget";

export type AllowanceChange = { tokens: number } | { unlimited: true } | { clear: true };

/**
 * What one organisation may spend of the operator's key, in place of its plan's, for the counter it is on now (a trial's, or
 * the month's). A figure set on one counter means nothing on the other. Refused for an organisation that is gone or being deleted.
 */
export async function setAiAllowance(
  organisationId: string,
  change: AllowanceChange
): Promise<{ status: "ok"; aiAllowance: IOrganisation["aiAllowance"] } | { status: "not_found" }> {
  if (!/^[0-9a-f]{24}$/i.test(organisationId)) return { status: "not_found" };
  await connectDB();
  const live = { _id: new Types.ObjectId(organisationId), deletedAt: null, deletingAt: null };
  if (!(await Organisation.exists(live))) return { status: "not_found" };

  if ("clear" in change) {
    await Organisation.updateOne(live, { $unset: { aiAllowance: 1 } });
    return { status: "ok", aiAllowance: null };
  }
  const aiAllowance = { tokens: "unlimited" in change ? null : change.tokens, scope: await counterKindOf(scoped(live._id)) };
  await Organisation.updateOne(live, { $set: { aiAllowance } });
  return { status: "ok", aiAllowance };
}
