import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { protocolOf } from "@/lib/middleware";
import { PROTOCOL_VERSION, WORKER_HEARTBEAT_MS, overriddenWorkerPolicy, registerWorker } from "@/lib/worker-service";
import {
  attachWorkerToEnrolment,
  consumeEnrolmentToken,
  enrolmentTokenOwner,
  enrolmentTokenOwnerId,
} from "@/lib/enrolment";
import { logInstanceAudit } from "@/lib/instanceAudit";

// Authenticated by a single-use enrolment token, NOT by an admin session or an admin API token.
//
// The reason is the laptop, not this route. A worker runs the coding agent at the same uid with
// Read and `bypassPermissions`, so anything on that disk is readable by the agent. While this was
// withAdmin, the credential the laptop had to hold was an unscoped instance-admin token — enough to
// PATCH lockedByInstance and lift the worker's own kill switch. An enrolment token is spent by the
// first registration and is useless afterwards, so reading it off disk buys nothing.
function bearerOf(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function POST(request: Request) {
  await connectDB();

  // Shape is checked before the token is spent: an operator gets one enrolment token, and burning
  // it on a missing field would mean minting another. Nothing here discloses anything a caller
  // without a token could not already read in the error text.
  const body = await request.json().catch(() => ({}));
  // Capped like the device flow does: whoever holds a valid enrolment token chooses these, and
  // they now land in an audit list an operator reads when something is already wrong
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  const host = typeof body.host === "string" ? body.host.trim().slice(0, 200) : "";
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
    // One message for every failure: telling a caller whether a token was real but spent, or never
    // existed, turns this into an oracle for guessing.
    return NextResponse.json({ error: "Invalid or spent enrolment token" }, { status: 401 });
  }

  const { worker, credential } = await registerWorker({
    name,
    host,
    platform: String(body.platform ?? ""),
    version: String(body.version ?? ""),
    // Names the machine's identity after the person who enrolled it — "Rafal · MacBook"
    owner: await enrolmentTokenOwner(consumed.tokenId),
    ownerId: (await enrolmentTokenOwnerId(consumed.tokenId)) ?? undefined,
  });

  await attachWorkerToEnrolment(consumed.tokenId, String(worker._id));

  // No user: the caller here is the machine, holding a token and no session. Which is the fact
  // worth recording — a token minted for one person and spent on an unexpected host is the shape
  // of a leaked enrolment.
  void logInstanceAudit({
    action: "enrolment_token_spent",
    target: worker.name,
    detail: `Registered ${host}`,
  });

  return NextResponse.json({
    workerId: String(worker._id),
    credential,
    heartbeatMs: WORKER_HEARTBEAT_MS,
    // Only what an operator set: everything else resolves against the worker's own
    // DEFAULT_POLICY, so raising a default reaches every machine that never pinned it
    policy: overriddenWorkerPolicy(worker),
    // Empty by design: a freshly registered worker has reported no checkouts yet, so there is
    // nothing to match a project against. The first heartbeat carries its inventory and gets them.
    assignments: [],
  });
}
