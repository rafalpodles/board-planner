import crypto from "crypto";
import bcrypt from "bcryptjs";
import { connectDB } from "./db";
import { DeviceEnrolment } from "@/models/deviceEnrolment";
import { Project } from "@/models/project";
import { projectRepositoryUrl } from "./repository";
import { IDeviceEnrolment } from "@/types";

const DEVICE_PREFIX = "cpd_";

const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";
const USER_CODE_LENGTH = 8;

export const DEVICE_ENROLMENT_TTL_MS = 15 * 60 * 1000;
export const DEVICE_POLL_INTERVAL_MS = 2_000;

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
    await DeviceEnrolment.deleteMany({ ...live, _id: { $in: surplus.map((row) => row._id) } });
  }

  const deviceCode = `${DEVICE_PREFIX}${crypto.randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(now.getTime() + DEVICE_ENROLMENT_TTL_MS);

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
      repositoryUrl: string;
      projectKey: string;
    };

export async function pollDeviceEnrolment(
  deviceCode: string,
  now = new Date()
): Promise<PollResult> {
  await connectDB();
  if (typeof deviceCode !== "string" || !deviceCode.startsWith(DEVICE_PREFIX)) {
    return { state: "expired" };
  }

  const candidates = await DeviceEnrolment.find({
    deviceCodePrefix: devicePrefixOf(deviceCode),
    status: { $in: ["pending", "approved"] },
  }).limit(20);

  for (const candidate of candidates) {
    if (!(await bcrypt.compare(deviceCode, candidate.deviceCodeHash))) continue;
    if (candidate.expiresAt.getTime() <= now.getTime()) return { state: "expired" };
    if (candidate.status === "pending") return { state: "pending" };

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
