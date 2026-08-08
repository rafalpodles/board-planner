import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The integration test stubs the board, so its refusal rule is a *copy* of the server's — the
 * worker is a separate package and cannot import from the app. A copy drifts silently: change
 * `recordTaskPhase`'s filter and the stub keeps answering by the old rule, leaving that test
 * green while it proves nothing about the server anyone actually runs.
 *
 * Reading the app's source is the one link available across the package boundary. This is a
 * tripwire, not a test of behaviour: when it fails, the fix is to update the stub in
 * `wiring.integration.test.ts` to match, then update the expectations here.
 */

const APP_TASK_SERVICE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/lib/task-service.ts"
);

/** The clauses the stub reproduces. Each one, if dropped server-side, changes what `applied` means. */
const FILTER_CLAUSES = [
  '_id: event.taskId',
  '"execution.workerId": event.workerId',
  '"execution.runId": event.runId',
  '{ "execution.phaseSeq": { $exists: false } }',
  '{ "execution.phaseSeq": { $lt: event.seq } }',
];

function recordTaskPhaseSource(): string {
  const source = readFileSync(APP_TASK_SERVICE, "utf8");
  const start = source.indexOf("export async function recordTaskPhase");
  expect(start, "recordTaskPhase is gone or renamed — the stub is describing a function that no longer exists").toBeGreaterThan(-1);
  const end = source.indexOf("\nexport ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("the stub's refusal rule still matches the server's", () => {
  it.each(FILTER_CLAUSES)("keys the update on %s", (clause) => {
    expect(recordTaskPhaseSource()).toContain(clause);
  });

  // The worker treats a false ack as "the task was taken from me". If the server ever returned
  // false for a third reason, that reading would be wrong and the abort would kill healthy runs.
  it("still reports whether the update matched, and nothing else", () => {
    expect(recordTaskPhaseSource()).toContain("return result.matchedCount > 0");
  });
});
