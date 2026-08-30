import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { connectDB } from "@/lib/db";
import { pollDeviceEnrolment } from "@/lib/device-enrolment";
import { WORKER_HEARTBEAT_MS } from "@/lib/worker-service";

// The app's half of the exchange, authenticated by holding the device code and nothing else.
// Answers the same shape whether a code was never issued, has expired, or has already been
// collected — three states an attacker would otherwise learn to tell apart.
export async function POST(request: Request) {
  await connectDB();

  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const body = read.value;
  const result = await pollDeviceEnrolment(String(body.deviceCode ?? ""));

  if (result.state === "approved") {
    return NextResponse.json({
      state: "approved",
      workerId: result.workerId,
      credential: result.credential,
      heartbeatMs: WORKER_HEARTBEAT_MS,
      // The app clones this into the folder the operator chose, as <folder>/<projectKey>
      repositoryUrl: result.repositoryUrl,
      projectKey: result.projectKey,
    });
  }

  // 200 for pending: this is a poll, not a failure, and a 4xx every two seconds reads as breakage
  // in every log it passes through
  if (result.state === "pending") return NextResponse.json({ state: "pending" });

  return NextResponse.json({ state: result.state }, { status: 410 });
}
