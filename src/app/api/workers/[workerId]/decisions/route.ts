import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { withWorker } from "@/lib/middleware";
import { readJsonBody } from "@/lib/request-body";
import { createDecision, settleDecision } from "@/lib/task-decisions";
import { TaskDecisionState } from "@/types";

/**
 * Deliberately not on a project path. `withProjectAccessOrWorker` falls through to
 * `withProjectAccess` when no `x-worker-id` header is present, so a route under
 * `/api/projects/:id/...` would let any project member post a record with `acceptable: true` and
 * then accept it — which is the whole control, inverted.
 */

// The patch this carries is bounded at 200 000 characters by the worker's own `collectDiff`, which
// is already past the 64 KB default. Far enough above that, and nowhere near a body worth
// buffering for its own sake.
const MAX_BODY_BYTES = 512 * 1024;

// What the route will store however long the worker's copy is. Redaction can only lengthen a
// patch — every match becomes `[redacted]` — so the worker's bound is not quite this side's.
const MAX_PATCH_CHARS = 220_000;

// A change touching more paths than this is not one anybody reads file by file, and the list is
// rendered in a browser
const MAX_FILES = 2000;
const MAX_PATH_CHARS = 512;
const MAX_REASON_CHARS = 500;

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .slice(0, MAX_FILES)
    .map((entry) => entry.trim().slice(0, MAX_PATH_CHARS));
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

const SHA256 = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^[0-9a-f]{7,64}$/;

export const POST = withWorker(async (request, { worker }) => {
  if (!worker.enabled || worker.lockedByInstance) {
    return NextResponse.json({ error: "this worker may not run", abort: true }, { status: 403 });
  }

  const body = await readJsonBody<Record<string, unknown>>(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;

  const { taskId, runId, commit, patchSha256 } = body.value;
  if (typeof taskId !== "string" || !isValidObjectId(taskId)) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }
  if (typeof runId !== "string" || !runId.trim()) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }
  // The commit is what a person is being asked to accept and what the machine later pushes by
  // name, so a value git would not read as an object id is refused rather than stored
  if (typeof commit !== "string" || !OBJECT_ID.test(commit)) {
    return NextResponse.json({ error: "commit must be a git object id" }, { status: 400 });
  }
  if (typeof patchSha256 !== "string" || !SHA256.test(patchSha256)) {
    return NextResponse.json({ error: "patchSha256 must be a sha256 digest" }, { status: 400 });
  }

  const gate = text(body.value.gate, 120).trim();
  if (!gate) {
    return NextResponse.json({ error: "gate is required" }, { status: 400 });
  }

  const acceptable = body.value.acceptable === true;
  const unacceptableReason = text(body.value.unacceptableReason, MAX_REASON_CHARS).trim();
  // A record nobody may accept has to say why, or the panel offers no button and no explanation
  if (!acceptable && !unacceptableReason) {
    return NextResponse.json(
      { error: "unacceptableReason is required when acceptable is false" },
      { status: 400 }
    );
  }

  const result = await createDecision(taskId, String(worker._id), runId, {
    gate,
    files: strings(body.value.files),
    protectedFiles: strings(body.value.protectedFiles),
    patch: text(body.value.patch, MAX_PATCH_CHARS),
    patchTruncated: body.value.patchTruncated === true,
    patchSha256,
    commit,
    taskKey: text(body.value.taskKey, 64).trim(),
    title: text(body.value.title, 300).trim(),
    acceptable,
    unacceptableReason,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ state: result.decision.state }, { status: 201 });
});

const SETTLEMENTS: TaskDecisionState[] = ["delivered", "refused", "failed", "discarded"];

export const PATCH = withWorker(async (request, { worker }) => {
  if (!worker.enabled || worker.lockedByInstance) {
    return NextResponse.json({ error: "this worker may not run", abort: true }, { status: 403 });
  }

  const body = await readJsonBody<Record<string, unknown>>(request);
  if (!body.ok) return body.response;

  const { taskId, state } = body.value;
  if (typeof taskId !== "string" || !isValidObjectId(taskId)) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }
  if (typeof state !== "string" || !SETTLEMENTS.includes(state as TaskDecisionState)) {
    return NextResponse.json(
      { error: `state must be one of ${SETTLEMENTS.join(", ")}` },
      { status: 400 }
    );
  }

  const attempts = body.value.attempts;
  const result = await settleDecision(taskId, String(worker._id), state as TaskDecisionState, {
    prUrl: text(body.value.prUrl, 500).trim(),
    error: text(body.value.error, MAX_REASON_CHARS).trim(),
    attempts: Number.isSafeInteger(attempts) && (attempts as number) >= 0 ? (attempts as number) : 0,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ state: result.decision.state });
});
