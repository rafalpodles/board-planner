import bcrypt from "bcryptjs";
import crypto from "crypto";
import { connectDB } from "@/lib/db";
import { User } from "@/models/user";
import { IUser } from "@/types";

// `Comment.author` is a required reference to a User, so without this a worker comments in the
// voice of whoever owns its credential — a falsified audit trail, and worse the moment a second
// person connects a machine. One identity per machine, because when something goes wrong the
// useful question is which machine. Widened from the PM agent's single shared user (pm-user.ts).

export function workerUsername(workerId: string): string {
  return `worker-${workerId}`;
}

export function workerDisplayName(machine: string, owner: string): string {
  const machineName = machine.trim() || "worker";
  const ownerName = owner.trim();
  return ownerName ? `${ownerName} · ${machineName}` : machineName;
}

export async function ensureWorkerUser(input: {
  workerId: string;
  machine: string;
  owner: string;
}): Promise<IUser> {
  await connectDB();

  const username = workerUsername(input.workerId);
  const fullName = workerDisplayName(input.machine, input.owner);

  // Random hash makes the account not loginable; the unique username index makes this race-safe.
  // fullName is refreshed on every registration so renaming a machine is not a second identity.
  const password = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 10);

  return User.findOneAndUpdate(
    { username },
    {
      $set: { fullName, kind: "machine" },
      $setOnInsert: {
        username,
        password,
        email: "",
        role: "member",
        allowedProjects: [],
      },
    },
    { upsert: true, returnDocument: "after" }
  ) as unknown as Promise<IUser>;
}
