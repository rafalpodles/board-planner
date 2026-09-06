import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { mintEnrolmentToken } from "@/lib/enrolment";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";

const MINTS_PER_WINDOW = 10;

export const POST = withAuth(async (request, { user }) => {
  await connectDB();

  if (user.viaMachineCredential) {
    return NextResponse.json({ error: "Interactive session required" }, { status: 403 });
  }

  const throttleKey = sourceKey(String(user._id), "enrolment_token_mint");
  if (await isRateLimited(throttleKey, MINTS_PER_WINDOW)) {
    return NextResponse.json({ error: "too many enrolment tokens, try again later" }, { status: 429 });
  }
  await recordFailedAttempt(throttleKey);

  const body = await request.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 200) : "";

  const { token, expiresAt } = await mintEnrolmentToken(String(user._id), label);

  void logInstanceAudit({
    action: "enrolment_token_minted",
    target: label || "unlabelled",
    user: String(user._id),
    actorUsername: user.username,
    detail: `Expires ${expiresAt.toISOString()}`,
  });

  return NextResponse.json({ token, expiresAt: expiresAt.toISOString() }, { status: 201 });
});
