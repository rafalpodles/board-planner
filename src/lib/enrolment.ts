import crypto from "crypto";
import bcrypt from "bcryptjs";
import { connectDB } from "./db";
import { EnrolmentToken } from "@/models/enrolmentToken";

// Long enough that guessing is hopeless, prefixed so a leaked string is recognisable in a log and
// so the lookup does not have to bcrypt-compare every row.
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

// Spending is a single conditional update, not read-then-write: two workers handed the same string
// would both pass a read check and both register, which is exactly the second live worker this
// credential exists to prevent.
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

    // Expiry is reported before spending, so an operator sees why it failed rather than "used"
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
