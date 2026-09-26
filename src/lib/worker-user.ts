import bcrypt from "bcryptjs";
import crypto from "crypto";
import { connectDB } from "@/lib/db";
import { FULL_NAME_MAX_LENGTH, stripControlCharacters } from "@/lib/identifiers";
import { User } from "@/models/user";
import { Worker } from "@/models/worker";
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

// Applied when a machine registers, and at boot by repairMachineNames — never on a heartbeat or a
// claim, so a machine's name changes only when it registers again.
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

const MACHINE_USERNAME = /^worker-[a-f0-9]{24}$/;

// A name written before registration sanitised it (BP-413) would otherwise stay until that machine
// registered again, and a dead machine never does (BP-425). Only a name the sanitiser would change
// is rewritten, and only while it still reads as it did, so a registration landing meanwhile wins.
export async function repairMachineNames(): Promise<number> {
  await connectDB();
  const machines = await User.find({ kind: "machine", username: { $regex: MACHINE_USERNAME } })
    .select("_id username fullName")
    .lean();
  const poisoned = machines.filter((m) => workerDisplayName(m.fullName ?? "", "") !== m.fullName);
  if (poisoned.length === 0) return 0;

  const workers = await Worker.find({
    _id: { $in: poisoned.map((m) => m.username.slice("worker-".length)) },
  })
    .select("_id name owner")
    .populate("owner", "fullName username")
    .lean();
  const byId = new Map(workers.map((w) => [String(w._id), w]));

  let repaired = 0;
  for (const user of poisoned) {
    const worker = byId.get(user.username.slice("worker-".length));
    const owner = worker?.owner as { fullName?: string; username?: string } | null | undefined;
    const ownerName = owner?.fullName?.trim() || owner?.username?.trim() || "";
    const fullName =
      worker && ownerName
        ? workerDisplayName(worker.name, ownerName)
        : workerDisplayName(user.fullName ?? "", "");
    if (fullName === user.fullName) continue;
    const written = await User.updateOne(
      { _id: user._id, fullName: user.fullName },
      { $set: { fullName } }
    );
    repaired += written.modifiedCount;
  }
  return repaired;
}
