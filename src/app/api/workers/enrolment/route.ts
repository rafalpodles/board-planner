import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { mintEnrolmentToken } from "@/lib/enrolment";
import { logInstanceAudit } from "@/lib/instanceAudit";
import { isRateLimited, recordFailedAttempt, sourceKey } from "@/lib/rate-limit";

// Each mint writes a row and costs a bcrypt hash. Its device-flow sibling has been rate-limited and
// capped since BP-305; the asymmetry did not matter while this was withAdmin and does now.
const MINTS_PER_WINDOW = 10;

// Minting requires an interactive session, never an API token. An API token can be read off a disk
// the agent can also read, and one that could mint enrolment tokens would hand back the very power
// this credential exists to remove.
//
// Not withAdmin since BP-358: the token names its creator, registration makes that person the
// machine's owner, and a machine reaches only what its owner reaches. Requiring an admin would gate
// the headless path on something the browser path stopped needing, and grant no less.
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

  // The token itself never goes near this log — it is returned once and only its hash is stored,
  // and an audit row is exactly the wrong place to undo that
  void logInstanceAudit({
    action: "enrolment_token_minted",
    target: label || "unlabelled",
    user: String(user._id),
    detail: `Expires ${expiresAt.toISOString()}`,
  });

  // Returned once and never retrievable again — only its hash is stored
  return NextResponse.json({ token, expiresAt: expiresAt.toISOString() }, { status: 201 });
});
