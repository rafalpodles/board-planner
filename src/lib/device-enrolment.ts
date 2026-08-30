import crypto from "crypto";
import bcrypt from "bcryptjs";
import { connectDB } from "./db";
import { DeviceEnrolment } from "@/models/deviceEnrolment";
import { Project } from "@/models/project";
import { projectRepositoryUrl } from "./repository";
import { IDeviceEnrolment } from "@/types";

// Long enough that guessing the app's half is hopeless
const DEVICE_PREFIX = "cpd_";

// What a person reads off one screen and types — or clicks through — on another. No vowels and no
// look-alikes, so nobody has to decide whether that was a zero or an O.
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";
const USER_CODE_LENGTH = 8;

export const DEVICE_ENROLMENT_TTL_MS = 15 * 60 * 1000;
// What the app waits between polls. Short enough to feel immediate, long enough not to hammer.
export const DEVICE_POLL_INTERVAL_MS = 2_000;

// Same shape the cp_/cpe_ credential paths use: an indexed, non-secret prefix narrows the
// candidates so exactly one bcrypt compare runs per poll. 8 hex of 64 leaves 224 bits of secret.
const DEVICE_PREFIX_LENGTH = DEVICE_PREFIX.length + 8;

export function devicePrefixOf(deviceCode: string): string {
  return deviceCode.slice(0, DEVICE_PREFIX_LENGTH);
}

export function formatUserCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normaliseUserCode(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

function randomUserCode(): string {
  const bytes = crypto.randomBytes(USER_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  }
  return out;
}

export interface StartedEnrolment {
  deviceCode: string;
  userCode: string;
  expiresAt: Date;
  intervalMs: number;
}

// Unauthenticated on purpose: the machine has nothing to authenticate with yet, which is the whole
// point. Nothing is granted here — a row in "pending" is worth nothing until a signed-in person
// confirms it, and it reaps itself in fifteen minutes if nobody does.
/**
 * How many pending rows the collection holds at once. It is a storage bound and nothing more.
 *
 * It used to refuse the caller that hit it, and it counted every caller's rows rather than one
 * caller's — the comment said "one unapproved caller" and the query said everybody (BP-305). So
 * twenty anonymous posts denied enrolment to every genuine operator until the rows reaped, over
 * and over. Scoping the count to the caller does not fix it either: `machineName` and `machineHost`
 * come from the request, and `getClientIp` is null on any instance that has not set
 * TRUSTED_PROXY_HOPS — which is the default (BP-318).
 *
 * So the ceiling drops the oldest pending row instead of refusing the newest. A pending row is
 * worth nothing until a signed-in person approves it, the rate limit above still bounds how fast
 * rows can be made, and an operator who asks to enrol always gets a code. What a flood can still
 * do is age somebody's row out before they finish typing it; at this size and that rate limit
 * that takes minutes, where refusing took one request.
 */
export const MAX_PENDING_ENROLMENTS = 100;

export async function startDeviceEnrolment(
  input: { machineName: string; machineHost: string },
  now = new Date()
): Promise<StartedEnrolment> {
  await connectDB();

  const live = { status: "pending", expiresAt: { $gt: now } };
  const pending = await DeviceEnrolment.countDocuments(live);
  if (pending >= MAX_PENDING_ENROLMENTS) {
    const surplus = await DeviceEnrolment.find(live)
      .sort({ createdAt: 1 })
      .limit(pending - MAX_PENDING_ENROLMENTS + 1)
      .select("_id")
      .lean();
    await DeviceEnrolment.deleteMany({ _id: { $in: surplus.map((row) => row._id) } });
  }

  const deviceCode = `${DEVICE_PREFIX}${crypto.randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(now.getTime() + DEVICE_ENROLMENT_TTL_MS);

  // Retried rather than assumed unique: the code is short by design, and a collision must not hand
  // a second machine someone else's approval
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = randomUserCode();
    try {
      await DeviceEnrolment.create({
        deviceCodeHash: await bcrypt.hash(deviceCode, 10),
        deviceCodePrefix: devicePrefixOf(deviceCode),
        userCode,
        machineName: input.machineName,
        machineHost: input.machineHost,
        status: "pending",
        expiresAt,
      });
      return { deviceCode, userCode, expiresAt, intervalMs: DEVICE_POLL_INTERVAL_MS };
    } catch (error) {
      const duplicate = (error as { code?: number })?.code === 11000;
      if (!duplicate || attempt === 4) throw error;
    }
  }
  throw new Error("could not allocate a user code");
}

export async function findPendingByUserCode(
  userCode: string,
  now = new Date()
): Promise<IDeviceEnrolment | null> {
  await connectDB();
  const enrolment = await DeviceEnrolment.findOne({ userCode: normaliseUserCode(userCode) });
  if (!enrolment) return null;
  if (enrolment.expiresAt.getTime() <= now.getTime()) return null;
  return enrolment;
}

export type PollResult =
  | { state: "pending" }
  | { state: "denied" }
  | { state: "expired" }
  | {
      state: "approved";
      workerId: string;
      credential: string;
      // What to clone and where to put it. The worker gets its own clone rather than borrowing the
      // operator's checkout — it registers worktrees inside whatever it is given and reaps beside
      // them, which is a hazard that has already bitten in this repository.
      repositoryUrl: string;
      projectKey: string;
    };

// The app's half. Matching is a bcrypt compare over the candidates sharing a user code, so a
// device code that was never issued cannot be told from one that was — and an approved row hands
// its credential over exactly once, then forgets it.
export async function pollDeviceEnrolment(
  deviceCode: string,
  now = new Date()
): Promise<PollResult> {
  await connectDB();
  if (typeof deviceCode !== "string" || !deviceCode.startsWith(DEVICE_PREFIX)) {
    return { state: "expired" };
  }

  // Narrowed by the indexed prefix rather than a 200-row window: the old shape ran up to 200
  // bcrypt compares per unauthenticated request, and sustained flooding pushed an approved
  // enrolment out of the window so its poll answered "expired" forever (BP-305)
  const candidates = await DeviceEnrolment.find({
    deviceCodePrefix: devicePrefixOf(deviceCode),
    status: { $in: ["pending", "approved"] },
  }).limit(20);

  for (const candidate of candidates) {
    if (!(await bcrypt.compare(deviceCode, candidate.deviceCodeHash))) continue;
    if (candidate.expiresAt.getTime() <= now.getTime()) return { state: "expired" };
    if (candidate.status === "pending") return { state: "pending" };

    // Single-use: the credential is cleared in the same conditional update that hands it back, so
    // two polls racing cannot both come away holding it.
    const claimed = await DeviceEnrolment.findOneAndUpdate(
      { _id: candidate._id, credential: { $ne: "" } },
      { $set: { credential: "", deliveredAt: now } },
      { returnDocument: "before" }
    );
    if (!claimed?.credential) return { state: "expired" };

    const project = claimed.project
      ? await Project.findById(claimed.project).select("key repositoryUrl githubRepo gitlabRepo gitlabHost").lean()
      : null;

    return {
      state: "approved",
      workerId: String(claimed.worker ?? ""),
      credential: claimed.credential,
      repositoryUrl: project ? projectRepositoryUrl(project) : "",
      projectKey: project?.key ?? "",
    };
  }

  return { state: "expired" };
}

export async function denyDeviceEnrolment(userCode: string): Promise<boolean> {
  await connectDB();
  const result = await DeviceEnrolment.updateOne(
    { userCode: normaliseUserCode(userCode), status: "pending" },
    { $set: { status: "denied", credential: "" } }
  );
  return result.modifiedCount > 0;
}
