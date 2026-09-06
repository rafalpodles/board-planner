import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { connectDB } from "@/lib/db";
import { pollDeviceEnrolment } from "@/lib/device-enrolment";
import { WORKER_HEARTBEAT_MS } from "@/lib/worker-service";

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
      repositoryUrl: result.repositoryUrl,
      projectKey: result.projectKey,
    });
  }

  if (result.state === "pending") return NextResponse.json({ state: "pending" });

  return NextResponse.json({ state: result.state }, { status: 410 });
}
