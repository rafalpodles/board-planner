import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { connectDB } from "@/lib/db";
import { protocolOf } from "@/lib/middleware";
import { PROTOCOL_VERSION } from "@/lib/worker-service";
import { stripControlCharacters } from "@/lib/identifiers";
import {
  DEVICE_ENROLMENT_TTL_MS,
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

export async function POST(request: Request) {
  await connectDB();

  if (protocolOf(request) !== PROTOCOL_VERSION) {
    return NextResponse.json(
      { error: `server speaks protocol ${PROTOCOL_VERSION}` },
      { status: 409 }
    );
  }

  const clientIp = getClientIp(request);
  const throttleKey = sourceKey(clientIp ?? "-", "device_enrolment");
  if (await isRateLimited(throttleKey, anonymousMultiplier(clientIp, ENROLMENTS_PER_WINDOW))) {
    return NextResponse.json({ error: "too many enrolment attempts, try again later" }, { status: 429 });
  }
  await recordFailedAttempt(throttleKey);

  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const body = read.value;
  const machineName = typeof body.name === "string"
    ? stripControlCharacters(body.name).trim().slice(0, 120)
    : "";
  const machineHost = typeof body.host === "string"
    ? stripControlCharacters(body.host).trim().slice(0, 200)
    : "";
  if (!machineName) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const started = await startDeviceEnrolment({ machineName, machineHost });
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";

  return NextResponse.json(
    {
      deviceCode: started.deviceCode,
      userCode: formatUserCode(started.userCode),
      verificationUrl: `${base}/enrol/${started.userCode}`,
      expiresAt: started.expiresAt.toISOString(),
      expiresInMs: DEVICE_ENROLMENT_TTL_MS,
      intervalMs: started.intervalMs,
    },
    { status: 201 }
  );
}
