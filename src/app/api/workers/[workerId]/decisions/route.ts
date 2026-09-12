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

// Arithmetic rather than taste, because a cap under the honest maximum is worse than no cap: the
// refusal is a 413 the worker logs, and the panel never appears at all.
//
//   patch                220 000 chars  (200 000 from collectDiff, and redaction can lengthen it)
//   files                128 000 chars  (MAX_FILES x MAX_PATH_CHARS)
//   protectedFiles       128 000 chars
//                        -------------
//                        476 000 chars, x6 bytes if every one of them escapes = 2.86 MB
//
// Four, so the worst case is inside it with the reason and the title still to come.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * What the route will store however long the worker's copy is.
 *
 * Redaction can lengthen a patch a long way, not a little: `URL_USERINFO` in the worker's
 * `scrub.ts` rewrites `<scheme>://<userinfo>@` to `<scheme>://[redacted]@`, and a patch of
 * `a://b@` repeated measures 198 002 characters in and 495 002 out — two and a half times. So the
 * worker's own 200 000-character bound says nothing about what arrives here, and this cap is
 * reached by ordinary redaction rather than only by something exotic.
 *
 * Which makes it load-bearing: a patch cut here and stored with `patchTruncated: false` is a
 * change the panel offers to accept while showing only part of it — exactly what `acceptability()`
 * refuses on the worker's side, reintroduced on this one. `truncatedPatch` below keeps the flag
 * honest, and `acceptability`'s answer is recomputed from it.
 */
const MAX_PATCH_CHARS = 220_000;

// A change touching more paths than this is not one anybody reads file by file, and the list is
// rendered in a browser. Kept small enough that `MAX_FILES × MAX_PATH_CHARS`, twice — `files` and
// `protectedFiles` — plus MAX_PATCH_CHARS still clears MAX_BODY_BYTES with room for JSON escaping:
// 2 × 500 × 256 is 256 KB against a 220 KB patch, inside the 4 MB cap above even if every
// character escapes to six bytes.
const MAX_FILES = 500;
const MAX_PATH_CHARS = 256;
const MAX_REASON_CHARS = 500;

/**
 * A bounded list of paths, and how many there really were.
 *
 * Both halves matter to a reader. The panel renders the list as "what tripped the gate" and the
 * count as the size of what accepting pushes, so a silently shortened list makes one of those
 * sentences smaller than the change it describes — the same defect `patchTruncated` exists to
 * prevent one field over.
 *
 * A path longer than the bound keeps a marker rather than being quietly shortened: a chip reading
 * `src/very/long/…` is visibly a cut name, where `src/very/long` is a filename that does not
 * exist.
 */
function paths(value: unknown): { kept: string[]; total: number } {
  if (!Array.isArray(value)) return { kept: [], total: 0 };
  const real = value.filter(
    (entry): entry is string => typeof entry === "string" && Boolean(entry.trim())
  );
  return {
    kept: real.slice(0, MAX_FILES).map((entry) => {
      const path = entry.trim();
      return path.length <= MAX_PATH_CHARS ? path : `${path.slice(0, MAX_PATH_CHARS - 1)}…`;
    }),
    total: real.length,
  };
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

const SHA256 = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^[0-9a-f]{7,64}$/;

/**
 * The pull request the settlement opened, as the panel will render it — an `href` a person clicks.
 *
 * A worker credential is readable by the agent off its own disk, so this string is as
 * worker-supplied as the patch is. React refuses a `javascript:` href and browsers block a
 * top-level `data:` navigation, so the hazard is a plausible link to somewhere else rather than
 * script execution — which is reason enough to insist it looks like what it claims to be.
 *
 * Exactly what `lastPrUrl` in the worker's `delivery.ts` can produce, and no wider. That agreement
 * is load-bearing rather than tidy: a settlement the board refuses is retried whole on the next
 * poll, so a shape the worker emits and this refuses would be a push, a `gh pr create`, and a 400,
 * every poll until the attempt ceiling stops it — with the board never told the url.
 *
 * Which is why `merge_requests` is not here, although an earlier draft admitted it and a comment
 * claimed the two regexes agreed. `lastPrUrl` matches `/pull/\d+` alone, `openPr` shells out to
 * `gh`, and a GitLab merge request is a url this worker cannot make. Admitting it would be
 * tolerance for a caller that does not exist; whoever adds GitLab delivery adds it to both.
 *
 * `https?` because `lastPrUrl` has it, and a self-hosted GitHub behind plain http is a real
 * deployment. The path is a segment class rather than `[^\s]*`, so
 * `https://evil.example.com/#/host/o/r/pull/1` cannot borrow the shape.
 */
const PR_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~-]+)*\/pull\/\d+$/;

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

  const claimedAcceptable = body.value.acceptable === true;
  const claimedReason = text(body.value.unacceptableReason, MAX_REASON_CHARS).trim();
  // A record nobody may accept has to say why, or the panel offers no button and no explanation
  if (!claimedAcceptable && !claimedReason) {
    return NextResponse.json(
      { error: "unacceptableReason is required when acceptable is false" },
      { status: 400 }
    );
  }

  const sent = text(body.value.patch, Number.MAX_SAFE_INTEGER);
  const patch = sent.slice(0, MAX_PATCH_CHARS);
  // Not the worker's flag alone: the slice above is a second, independent way for the patch to
  // stop being the whole change, and the person is owed the same answer either way.
  const patchTruncated = body.value.patchTruncated === true || patch.length < sent.length;
  const acceptable = claimedAcceptable && !patchTruncated;
  const unacceptableReason =
    claimedReason ||
    (acceptable
      ? ""
      : "the change is larger than the patch this record can carry, so what is shown below is not all of it. Nobody can accept a change they have not been shown.");

  const files = paths(body.value.files);
  const protectedFiles = paths(body.value.protectedFiles);

  const result = await createDecision(taskId, String(worker._id), runId, {
    gate,
    files: files.kept,
    fileCount: files.total,
    protectedFiles: protectedFiles.kept,
    protectedFileCount: protectedFiles.total,
    patch,
    patchTruncated,
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

  const prUrl = text(body.value.prUrl, 500).trim();
  if (prUrl && !PR_URL.test(prUrl)) {
    return NextResponse.json({ error: "prUrl must be a pull request url" }, { status: 400 });
  }

  const attempts = body.value.attempts;
  const result = await settleDecision(taskId, String(worker._id), state as TaskDecisionState, {
    prUrl,
    error: text(body.value.error, MAX_REASON_CHARS).trim(),
    attempts: Number.isSafeInteger(attempts) && (attempts as number) >= 0 ? (attempts as number) : 0,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ state: result.decision.state });
});
