import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { connectDB } from "@/lib/db";
import { protocolOf, hostNotFound } from "@/lib/middleware";
import { PROTOCOL_VERSION } from "@/lib/worker-service";
import { stripControlCharacters } from "@/lib/identifiers";
import {
  DEVICE_ENROLMENT_TTL_MS,
  formatUserCode,
  startDeviceEnrolment,
} from "@/lib/device-enrolment";
import { getClientIp } from "@/lib/auth";
import { originFor } from "@/lib/organisation-host";
import { sourceRefused } from "@/lib/rate-limit";
import { scopedForRequest } from "@/lib/db-scope";

const ENROLMENTS_PER_WINDOW = 10;

// Unauthenticated, and that is the point: the machine has nothing to authenticate with yet — this
// exists so nobody has to copy a token onto it by hand. Nothing is granted here. A pending row is
// worth nothing until a signed-in person confirms it, and it reaps itself in fifteen minutes.
export async function POST(request: Request) {
  const db = await scopedForRequest(request);
  if (!db) return hostNotFound();
  await connectDB();

  if (protocolOf(request) !== PROTOCOL_VERSION) {
    return NextResponse.json(
      { error: `server speaks protocol ${PROTOCOL_VERSION}` },
      { status: 409 }
    );
  }

  const origin = await originFor(db);
  if (!origin) {
    console.error("Worker enrolment requested with no PUBLIC_ORIGIN configured");
    return NextResponse.json(
      { error: "This instance's own origin is not configured. Set PUBLIC_ORIGIN (or give APP_ORIGIN exactly one origin): the machine sends its operator there to approve it." },
      { status: 500 }
    );
  }

  // Unauthenticated, and every call writes a row that may push somebody's out of the pending cap,
  // so the address is what a flood is held to. With no address there is nobody to count and a
  // bucket shared by all would let one caller stop every machine enrolling; nothing costly runs
  // per call (BP-1030), and the cap drops the oldest row instead of refusing the newest.
  // Counted before the body is understood, so malformed or oversized requests spend it too.
  if (await sourceRefused(getClientIp(request), "device_enrolment", ENROLMENTS_PER_WINDOW)) {
    return NextResponse.json({ error: "too many enrolment attempts, try again later" }, { status: 429 });
  }

  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const body = read.value;
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

  const started = await startDeviceEnrolment(db, { machineName, machineHost });

  return NextResponse.json(
    {
      deviceCode: started.deviceCode,
      userCode: formatUserCode(started.userCode),
      // Where to send the operator. Carries the code so the common path is a click, not typing.
      verificationUrl: `${origin}/enrol/${started.userCode}`,
      expiresAt: started.expiresAt.toISOString(),
      expiresInMs: DEVICE_ENROLMENT_TTL_MS,
      intervalMs: started.intervalMs,
    },
    { status: 201 }
  );
}
