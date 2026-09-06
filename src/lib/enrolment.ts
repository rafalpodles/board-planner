import crypto from "crypto";
import bcrypt from "bcryptjs";
import { connectDB } from "./db";
import { EnrolmentToken } from "@/models/enrolmentToken";

const PREFIX = "cpe_";
const PREFIX_LENGTH = PREFIX.length + 8;

export const ENROLMENT_TTL_MS = 60 * 60 * 1000;

export type ConsumeResult =
  | { ok: true; tokenId: string }
  | { ok: false; reason: "unknown" | "used" | "expired" };

export async function mintEnrolmentToken(
  createdBy: string,
  label = "",
  now = new Date()
): Promise<{ token: string; expiresAt: Date }> {
  await connectDB();
  const token = `${PREFIX}${crypto.randomBytes(24).toString("hex")}`;
  const expiresAt = new Date(now.getTime() + ENROLMENT_TTL_MS);

  await EnrolmentToken.create({
    prefix: token.substring(0, PREFIX_LENGTH),
    tokenHash: await bcrypt.hash(token, 10),
    createdBy,
    label,
    expiresAt,
    usedAt: null,
    usedByWorker: null,
  });

  return { token, expiresAt };
}

export async function enrolmentTokenOwner(tokenId: string): Promise<string> {
  await connectDB();
  const token = await EnrolmentToken.findById(tokenId).populate("createdBy", "fullName username").lean();
  const owner = token?.createdBy as { fullName?: string; username?: string } | null | undefined;
  return owner?.fullName?.trim() || owner?.username?.trim() || "";
}

export async function enrolmentTokenOwnerId(tokenId: string): Promise<string | null> {
  await connectDB();
  const token = await EnrolmentToken.findById(tokenId).select("createdBy").lean();
  return token?.createdBy ? String(token.createdBy) : null;
}

export async function consumeEnrolmentToken(
  token: string,
  now = new Date()
): Promise<ConsumeResult> {
  if (typeof token !== "string" || !token.startsWith(PREFIX)) {
    return { ok: false, reason: "unknown" };
  }
  await connectDB();

  const candidates = await EnrolmentToken.find({ prefix: token.substring(0, PREFIX_LENGTH) });
  for (const candidate of candidates) {
    if (!(await bcrypt.compare(token, candidate.tokenHash))) continue;

    if (candidate.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };

    const spent = await EnrolmentToken.findOneAndUpdate(
      { _id: candidate._id, usedAt: null },
      { $set: { usedAt: now } },
      { new: true }
    );
    if (!spent) return { ok: false, reason: "used" };
    return { ok: true, tokenId: String(candidate._id) };
  }

  return { ok: false, reason: "unknown" };
}

export async function attachWorkerToEnrolment(tokenId: string, workerId: string): Promise<void> {
  await EnrolmentToken.findByIdAndUpdate(tokenId, { $set: { usedByWorker: workerId } });
}
