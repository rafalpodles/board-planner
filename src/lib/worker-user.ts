import bcrypt from "bcryptjs";
import crypto from "crypto";
import { connectDB } from "@/lib/db";
import { FULL_NAME_MAX_LENGTH, stripControlCharacters } from "@/lib/identifiers";
import { User } from "@/models/user";
import { IUser } from "@/types";

// `Comment.author` is a required reference to a User, so without this a worker comments in the
// voice of whoever owns its credential — a falsified audit trail, and worse the moment a second
// person connects a machine. One identity per machine, because when something goes wrong the
// useful question is which machine. Widened from the PM agent's single shared user (pm-user.ts).

export function workerUsername(workerId: string): string {
  return `worker-${workerId}`;
}

// [...string] rather than a plain slice, so a surrogate pair is kept or dropped whole rather than
// cut in half into two unpaired halves
function capLength(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

export function workerDisplayName(machine: string, owner: string): string {
  const machineName = stripControlCharacters(machine).trim() || "worker";
  const ownerName = stripControlCharacters(owner).trim();
  const composed = ownerName ? `${ownerName} · ${machineName}` : machineName;
  // The cap applies to the composed string, not each half separately: the two inputs are already
  // bounded well under it on their own (register.ts caps `name` at 120, but a display name that
  // long has never been the point), and a name it still had to shorten is display text, not an
  // identifier — a truncated "Owner · MacBook P" is a worse cosmetic than a rejected enrolment
  // would be a functional one.
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
      },
    },
    { upsert: true, returnDocument: "after" }
  ) as unknown as Promise<IUser>;
}
