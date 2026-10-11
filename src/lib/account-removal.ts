import type { HydratedDocument } from "mongoose";
import type { ScopedDb } from "@/lib/db-scope";
import { eraseAccountTraces } from "@/lib/account-erasure";
import { boardsLeftWithoutOwner, boardsOnlyOwnedBy } from "@/lib/grants";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { warnIfAdminsLockedOut } from "@/lib/password-sign-in";
import { revokeUserCredentials } from "@/lib/session";
import type { IUser } from "@/types";

const ACTIVE_ADMINS = { role: "admin", deactivatedAt: null } as const;

export type AccountRemoval =
  | { ok: true }
  | { ok: false; status: 404 | 400 | 409; error: string; boards?: unknown[] };

/**
 * Deletes an account for good, whoever asks: an administrator removing a colleague, or a person
 * removing themselves. The refusals are the ones that keep an organisation standing — it never ends
 * with no administrator and a board never ends with no owner — so neither path can skip them.
 */
export async function removeAccount(
  db: ScopedDb,
  user: HydratedDocument<IUser>,
  actor: Pick<IUser, "_id" | "username">,
  { subject }: { subject: "their own account" | "this account" }
): Promise<AccountRemoval> {
  const own = subject === "their own account";
  const you = own ? "You are" : `${user.username} is`;
  const yourself = own ? "your" : "this";

  // The invariant PUT keeps for demotion, kept here too. Unreachable for an administrator looking at
  // someone else while the self-delete guard holds, which is why it is here: that guard failed once,
  // and an instance with no administrator cannot be repaired from the product.
  if (user.role === "admin" && !user.deactivatedAt) {
    const adminCount = await db.User.countDocuments(ACTIVE_ADMINS);
    if (adminCount <= 1) {
      return {
        ok: false,
        status: 400,
        error: own
          ? "You are the last administrator of this organisation. Make someone else an administrator before deleting your account."
          : "Cannot delete the last admin",
      };
    }
  }

  const soleOwned = await boardsOnlyOwnedBy(db, String(user._id));
  if (soleOwned.length > 0) {
    const names = soleOwned.map((b) => `${b.name} (${b.key})`).join(", ");
    return {
      ok: false,
      status: 409,
      error: `${you} the only owner of ${names}. Make someone else an owner there before deleting ${yourself} account.`,
      boards: soleOwned,
    };
  }

  // A delete cannot be undone, so the account first stops counting, as a deactivated one does, and
  // the two invariants are counted again without it: a demotion, deactivation or removal racing
  // this one counted this account as still there (BP-841)
  if (!user.deactivatedAt) {
    const markedAt = new Date();
    const marked = await db.User.updateOne({ _id: user._id, deactivatedAt: null }, { $set: { deactivatedAt: markedAt } });
    if (marked.modifiedCount > 0) {
      const lastAdminGone = user.role === "admin" && (await db.User.countDocuments(ACTIVE_ADMINS)) === 0;
      const ownerless = lastAdminGone ? [] : await boardsLeftWithoutOwner(db, String(user._id));
      if (lastAdminGone || ownerless.length > 0) {
        // Only this request's own mark: a deactivation landing meanwhile stays
        await db.User.updateOne({ _id: user._id, deactivatedAt: markedAt }, { $set: { deactivatedAt: null } });
        return {
          ok: false,
          status: 409,
          error: lastAdminGone ? "Cannot delete the last admin" : "Another owner of the same board was removed meanwhile",
        };
      }
    }
  }

  // Before the delete, and after the mark above: a failure here leaves a deactivated account that
  // can be deleted again, where erasing afterwards would leave traces nobody can name any more
  const label = await eraseAccountTraces(db, user);

  // The delete's own answer, not a discarded one: two requests deleting the same account otherwise
  // both hear that they did it, and the checks above are read-then-write.
  const deleted = await db.User.findByIdAndDelete(user._id);
  if (!deleted) return { ok: false, status: 404, error: "User not found" };

  // After the delete and BEFORE the revoke, which is the opposite order to the password path: there,
  // nothing is committed until the save, so a failed revoke must leave the account untouched. Here
  // the account is already gone, and a revoke that throws would take the only record of it having
  // existed with it. Named by an opaque label, not the username, so the log does not keep it.
  void logInstanceAudit(db, {
    action: "user_deleted",
    user: actor._id,
    actorUsername: String(actor._id) === String(user._id) ? label : actor.username,
    target: label,
    detail: own ? "by the person themselves" : user.role === "admin" ? "an administrator" : "a member",
  });

  await db.Grant.deleteMany({ subject: user._id });
  await revokeUserCredentials(user._id);
  if (user.role === "admin") void warnIfAdminsLockedOut(db, "an administrator's deletion");

  return { ok: true };
}
