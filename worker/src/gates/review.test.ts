import { describe, it, expect, vi, afterEach } from "vitest";
import { reviewGate } from "./review.js";
import { CommandResult, Runner } from "../exec.js";
import { ClaimedTask, DiffStats, GateContext } from "../types.js";

const TIMEOUT_MS = 5000;

const patch = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-export const a = 1;",
  "+export const a = 2;",
].join("\n");

function context(diff: Partial<DiffStats> = {}, task: Partial<ClaimedTask> = {}): GateContext {
  return {
    worktreePath: "/wt",
    task: {
      taskId: "1",
      taskKey: "CP-158",
      taskNumber: 158,
      title: "Add a thing",
      description: "body",
      acceptanceCriteria: [],
      attempts: 0,
      ...task,
    },
    result: {
      status: "completed",
      summary: "I did exactly what the task asked",
      filesChanged: ["a.ts"],
      testsAdded: ["a.test.ts"],
      blockedReason: "",
    },
    diff: { changedLines: 2, changedFiles: ["a.ts"], patch, truncated: false, ...diff },
  };
}

function claudeStdout(stdout: string, overrides: Partial<CommandResult> = {}) {
  const run = vi
    .fn<Runner["run"]>()
    .mockResolvedValue({ code: 0, stdout, stderr: "", timedOut: false, ...overrides });
  return { runner: { run }, run };
}

function claudeReturning(verdict: unknown) {
  return claudeStdout(JSON.stringify({ result: JSON.stringify(verdict) }));
}

function promptOf(run: ReturnType<typeof claudeStdout>["run"]): string {
  return run.mock.calls[0][1].join(" ");
}

describe("reviewGate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts an approving verdict", async () => {
    const { runner } = claudeReturning({ approved: true, reason: "looks right" });

    expect((await reviewGate(runner, TIMEOUT_MS).run(context())).ok).toBe(true);
  });

  it("rejects and carries the reviewer's reason", async () => {
    const { runner } = claudeReturning({ approved: false, reason: "drops the error branch" });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/drops the error branch/);
  });

  it("passes the diff and the task in the prompt", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context({}, { acceptanceCriteria: ["handles zero"] }));

    const prompt = promptOf(run);
    expect(prompt).toContain("diff --git a/a.ts");
    expect(prompt).toContain("CP-158");
    expect(prompt).toContain("handles zero");
  });

  it("labels the task and the diff as untrusted data rather than instructions", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(promptOf(run)).toMatch(/untrusted/i);
    expect(promptOf(run)).toMatch(/not instructions/i);
  });

  it("withholds the author's own summary so the reviewer is not primed by it", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(promptOf(run)).not.toContain("I did exactly what the task asked");
  });

  it("rejects a truncated diff without spawning a reviewer", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context({ truncated: true }));

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too large/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an empty patch without spawning a reviewer", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context({ patch: "   \n" }));

    expect(result.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("reviews inside the worktree under the given budget", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(run.mock.calls[0][0]).toBe("claude");
    expect(run.mock.calls[0][2].cwd).toBe("/wt");
    expect(run.mock.calls[0][2].timeoutMs).toBe(TIMEOUT_MS);
  });

  it("never passes an API key so the subscription is used", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(run.mock.calls[0][2].env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(run.mock.calls[0][2].env?.PATH).toBe(process.env.PATH);
  });

  it("fails closed when the reviewer output cannot be parsed", async () => {
    const { runner } = claudeStdout("garbage");

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be completed/i);
  });

  it("fails closed on a timeout and says the review never ran", async () => {
    const { runner } = claudeStdout("", { code: -1, timedOut: true });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be completed/i);
    expect(result.reason).toMatch(/timed out after 5000ms/);
  });

  it("fails closed on a non-zero exit and carries the error", async () => {
    const envelope = JSON.stringify({ result: '{"approved":true,"reason":"fine"}' });
    const { runner } = claudeStdout(envelope, {
      code: 1,
      stderr: "Claude usage limit reached",
    });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be completed/i);
    expect(result.reason).toMatch(/usage limit reached/);
  });

  it.each([
    ["approved as a string", { approved: "true", reason: "ship it" }],
    ['approved as the string "false"', { approved: "false", reason: "no" }],
    ["approved as a number", { approved: 1, reason: "ship it" }],
    ["a different field name", { verdict: "approve", reason: "ship it" }],
    ["a missing reason", { approved: true }],
    ["a non-string reason", { approved: true, reason: 5 }],
    ["a bare boolean", true],
    ["a null payload", null],
  ])("fails closed on a verdict with %s", async (_label, verdict) => {
    const { runner } = claudeReturning(verdict);

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be completed/i);
  });

  it("fails closed when the envelope carries no result", async () => {
    const { runner } = claudeStdout(JSON.stringify({ is_error: true, subtype: "error_max_turns" }));

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be completed/i);
  });

  it("accepts a verdict delivered as an object rather than a JSON string", async () => {
    const { runner } = claudeStdout(
      JSON.stringify({ result: { approved: true, reason: "matches the task" } })
    );

    expect((await reviewGate(runner, TIMEOUT_MS).run(context())).ok).toBe(true);
  });

  it("tolerates noise printed before the envelope", async () => {
    const { runner } = claudeStdout(
      `warning: config not found\n${JSON.stringify({ result: '{"approved":false,"reason":"missing a null check"}' })}`
    );

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing a null check/);
  });

  it("distinguishes a substantive rejection from a review that never ran", async () => {
    const { runner } = claudeReturning({ approved: false, reason: "drops the error branch" });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.reason).not.toMatch(/could not be completed/i);
  });
});
