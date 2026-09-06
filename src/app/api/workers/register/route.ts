import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { connectDB } from "@/lib/db";
import { protocolOf } from "@/lib/middleware";
import { stripControlCharacters } from "@/lib/identifiers";
import {
  PROTOCOL_VERSION,
  WORKER_HEARTBEAT_MS,
  WorkerAlreadyOwned,
  overriddenWorkerPolicy,
  registerWorker,
} from "@/lib/worker-service";
import {
  attachWorkerToEnrolment,
  consumeEnrolmentToken,
  enrolmentTokenOwner,
  enrolmentTokenOwnerId,
} from "@/lib/enrolment";
import { logInstanceAudit } from "@/lib/instanceAudit";

function bearerOf(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function POST(request: Request) {
  await connectDB();

  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const body = read.value;
  const name = typeof body.name === "string"
    ? stripControlCharacters(body.name).trim().slice(0, 120)
    : "";
  const host = typeof body.host === "string"
    ? stripControlCharacters(body.host).trim().slice(0, 200)
    : "";
  if (!name || !host) {
    return NextResponse.json({ error: "name and host are required" }, { status: 400 });
  }
  if (protocolOf(request) !== PROTOCOL_VERSION) {
    return NextResponse.json(
      { error: `server speaks protocol ${PROTOCOL_VERSION}` },
      { status: 409 }
    );
  }

  const consumed = await consumeEnrolmentToken(bearerOf(request));
  if (!consumed.ok) {
    return NextResponse.json({ error: "Invalid or spent enrolment token" }, { status: 401 });
  }

  let registered;
  try {
    registered = await registerWorker({
      name,
      host,
      platform: String(body.platform ?? ""),
      version: String(body.version ?? ""),
      owner: await enrolmentTokenOwner(consumed.tokenId),
      ownerId: (await enrolmentTokenOwnerId(consumed.tokenId)) ?? undefined,
    });
  } catch (error) {
    if (error instanceof WorkerAlreadyOwned) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
  const { worker, credential } = registered;

  await attachWorkerToEnrolment(consumed.tokenId, String(worker._id));

  void logInstanceAudit({
    action: "enrolment_token_spent",
    target: worker.name,
    detail: `Registered ${host}`,
  });

  return NextResponse.json({
    workerId: String(worker._id),
    credential,
    heartbeatMs: WORKER_HEARTBEAT_MS,
    policy: overriddenWorkerPolicy(worker),
    assignments: [],
  });
}
