import bcrypt from "bcryptjs";
import crypto from "crypto";
import { connectDB } from "@/lib/db";
import { User } from "@/models/user";
import { IUser } from "@/types";
import { PM_USERNAME } from "@/lib/pm/username";

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

export async function getPmUser(): Promise<IUser> {
  await connectDB();

  const existing = await User.findOne({ username: PM_USERNAME });
  if (existing) return existing;

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
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  return user;
}
