import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_TASK_SERVICE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/lib/task-service.ts"
);

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

  it("still reports whether the update matched, and nothing else", () => {
    expect(recordTaskPhaseSource()).toContain("return result.matchedCount > 0");
  });
});
