import bcrypt from "bcryptjs";
import crypto from "crypto";
import { connectDB } from "@/lib/db";
import { User } from "@/models/user";
import { IUser } from "@/types";

export async function getPmUser(): Promise<IUser> {
  await connectDB();

  const existing = await User.findOne({ username: "pm" });
  if (existing) return existing;

  // Random hash makes the account not loginable; unique username index makes the upsert race-safe
  const password = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 10);
  const user = await User.findOneAndUpdate(
    { username: "pm" },
    {
      $setOnInsert: {
        username: "pm",
        password,
        fullName: "PM Agent",
        email: "",
        role: "member",
        allowedProjects: [],
      },
    },
    { upsert: true, new: true }
  );
  return user;
}
