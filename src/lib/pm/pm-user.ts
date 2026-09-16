import bcrypt from "bcryptjs";
import crypto from "crypto";
import { connectDB } from "@/lib/db";
import { User } from "@/models/user";
import { IUser } from "@/types";
import { PM_USERNAME } from "@/lib/pm/username";
import { revokeUserCredentials } from "@/lib/session";

export { PM_USERNAME };

/**
 * The PM's id, or null when the account does not exist yet. Deliberately not `getPmUser`, which
 * upserts: this is called by the claim on every worker poll, and a poll must not be what brings
 * the PM account into being on an instance that has never run one.
 */
export async function pmUserId(): Promise<string | null> {
  await connectDB();
  const pm = await User.findOne({ username: PM_USERNAME }, "_id").lean();
  return pm ? String(pm._id) : null;
}

// BP-348: releases before this stored the PM account as a person, so it was listed and could be given
// a password. Run at boot, before anyone can act on it.
export async function markPmAsMachine(): Promise<void> {
  await connectDB();
  const stored = await User.findOne({ username: PM_USERNAME, kind: { $ne: "machine" } });
  if (!stored) return;
  await User.updateOne({ _id: stored._id }, { $set: { kind: "machine" } });
  await revokeUserCredentials(stored._id);
  console.warn(
    `The "${PM_USERNAME}" account was stored as a person (role ${stored.role}${stored.email ? `, email ${stored.email}` : ""}). It is now the PM's machine identity: it can no longer sign in, and its sessions, tokens and machines were revoked.`
  );
}

export async function getPmUser(): Promise<IUser> {
  await connectDB();

  const existing = await User.findOne({ username: PM_USERNAME });
  if (existing?.kind === "machine") return existing;
  if (existing) {
    existing.kind = "machine";
    const saved = await existing.save();
    await revokeUserCredentials(existing._id);
    return saved;
  }

  // Random hash makes the account not loginable; unique username index makes the upsert race-safe
  const password = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 10);
  const user = await User.findOneAndUpdate(
    { username: PM_USERNAME },
    {
      $setOnInsert: {
        username: PM_USERNAME,
        password,
        fullName: "PM Agent",
        email: "",
        role: "member",
        kind: "machine",
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  return user;
}
