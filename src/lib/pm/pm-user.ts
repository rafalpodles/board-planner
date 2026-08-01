import bcrypt from "bcryptjs";
import crypto from "crypto";
import { connectDB } from "@/lib/db";
import { User } from "@/models/user";
import { IUser } from "@/types";

export const PM_USERNAME = "pm";

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
        allowedProjects: [],
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  return user;
}
