import bcrypt from "bcryptjs";
import crypto from "crypto";
import { connectDB } from "@/lib/db";
import { FULL_NAME_MAX_LENGTH, isControlCodePoint } from "@/lib/identifiers";
import { User } from "@/models/user";
import { IUser } from "@/types";

// `Comment.author` is a required reference to a User, so without this a worker comments in the
// voice of whoever owns its credential — a falsified audit trail, and worse the moment a second
// person connects a machine. One identity per machine, because when something goes wrong the
// useful question is which machine. Widened from the PM agent's single shared user (pm-user.ts).

export function workerUsername(workerId: string): string {
  return `worker-${workerId}`;
}

// `machine` and `owner` both reach here from routes a stranger can reach with no session at all —
// /api/workers/register and the device-enrolment start route take an arbitrary name, rate-limited
// but not authenticated. BP-410 put a rule on a person's own fullName (no control characters, at
// most FULL_NAME_MAX_LENGTH), and this field reaches the same sinks: a notification title on its
// way into Slack or Discord markup, and a line in the PM agent's system prompt. But nobody is
// sitting at that route to hand a 400 to and ask to retype — the request has already succeeded
// against every check that could reject it, and refusing here would refuse the enrolment itself.
// So this strips rather than rejects.
function stripControlCharacters(value: string): string {
  let out = "";
  for (const character of value) {
    if (!isControlCodePoint(character.codePointAt(0) ?? 0)) out += character;
  }
  return out;
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
  // identifier — a truncated "Rafal · MacBook P" is a worse cosmetic than a rejected enrolment
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
