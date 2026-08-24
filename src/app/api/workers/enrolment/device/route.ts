import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { protocolOf } from "@/lib/middleware";
import { PROTOCOL_VERSION } from "@/lib/worker-service";
import { stripControlCharacters } from "@/lib/identifiers";
import {
  DEVICE_ENROLMENT_TTL_MS,
  TooManyPendingEnrolments,
  formatUserCode,
  startDeviceEnrolment,
} from "@/lib/device-enrolment";
import { getClientIp } from "@/lib/auth";
import {
  anonymousMultiplier,
  isRateLimited,
  recordFailedAttempt,
  sourceKey,
} from "@/lib/rate-limit";

const ENROLMENTS_PER_WINDOW = 10;

// Unauthenticated, and that is the point: the machine has nothing to authenticate with yet — this
// exists so nobody has to copy a token onto it by hand. Nothing is granted here. A pending row is
// worth nothing until a signed-in person confirms it, and it reaps itself in fifteen minutes.
export async function POST(request: Request) {
  await connectDB();

  const body = await request.json().catch(() => ({}));
  // Stripped before it is ever stored, not only where it becomes a User's fullName: this value is
  // rendered raw on /enrol/[userCode] BEFORE anyone approves it, and a bidi-override or zero-width
  // character does not break a line or reach a script sink — it just makes the string on screen
  // lie to whoever is deciding whether to trust it, which is the entire control this unauthenticated
  // route has (BP-413 review).
  const machineName = typeof body.name === "string"
    ? stripControlCharacters(body.name).trim().slice(0, 120)
    : "";
  const machineHost = typeof body.host === "string"
    ? stripControlCharacters(body.host).trim().slice(0, 200)
    : "";
  if (!machineName) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (protocolOf(request) !== PROTOCOL_VERSION) {
    return NextResponse.json(
      { error: `server speaks protocol ${PROTOCOL_VERSION}` },
      { status: 409 }
    );
  }

  // Unauthenticated and costing a bcrypt.hash per call, so the address is the only bound there is
  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "device_enrolment");
  // Shared key when there is no address, so the per-address figure would be a lever one caller
  // could hold down against every machine trying to enrol
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, ENROLMENTS_PER_WINDOW))) {
    return NextResponse.json({ error: "too many enrolment attempts, try again later" }, { status: 429 });
  }
  await recordFailedAttempt(throttleKey);

  let started;
  try {
    started = await startDeviceEnrolment({ machineName, machineHost });
  } catch (error) {
    if (error instanceof TooManyPendingEnrolments) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    throw error;
  }
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";

  return NextResponse.json(
    {
      deviceCode: started.deviceCode,
      userCode: formatUserCode(started.userCode),
      // Where to send the operator. Carries the code so the common path is a click, not typing.
      verificationUrl: `${base}/enrol/${started.userCode}`,
      expiresAt: started.expiresAt.toISOString(),
      expiresInMs: DEVICE_ENROLMENT_TTL_MS,
      intervalMs: started.intervalMs,
    },
    { status: 201 }
  );
}
