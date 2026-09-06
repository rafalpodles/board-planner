import bcrypt from "bcryptjs";
import crypto from "crypto";
import { connectDB } from "@/lib/db";
import { FULL_NAME_MAX_LENGTH, stripControlCharacters } from "@/lib/identifiers";
import { User } from "@/models/user";
import { IUser } from "@/types";

export function workerUsername(workerId: string): string {
  return `worker-${workerId}`;
}

function capLength(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

export function workerDisplayName(machine: string, owner: string): string {
  const machineName = stripControlCharacters(machine).trim() || "worker";
  const ownerName = stripControlCharacters(owner).trim();
  const composed = ownerName ? `${ownerName} · ${machineName}` : machineName;
  return capLength(composed, FULL_NAME_MAX_LENGTH);
}

export async function ensureWorkerUser(input: {
  workerId: string;
  machine: string;
  owner: string;
}): Promise<IUser> {
  await connectDB();

  const username = workerUsername(input.workerId);
  const fullName = workerDisplayName(input.machine, input.owner);

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
      },
    },
    { upsert: true, returnDocument: "after" }
  ) as unknown as Promise<IUser>;
}
