import { describe, it, expect, vi } from "vitest";
import { createExecutor } from "./executor.js";

const config = { taskTimeoutMs: 1000, apiBaseUrl: "https://app.example.com", apiToken: "cp_t" } as never;

const task = {
  taskId: "t1",
  taskKey: "CP-158",
  taskNumber: 158,
  title: "Add a thing",
  description: "Do it well",
  acceptanceCriteria: ["works"],
  attempts: 1,
};

function runnerReturning(result: Record<string, unknown>) {
  const run = vi.fn().mockResolvedValue(result);
  return { runner: { run }, run };
}

describe("createExecutor", () => {
  it("parses a schema-conforming result", async () => {
    const payload = {
      status: "completed",
      summary: "done",
      filesChanged: ["a.ts"],
      testsAdded: ["a.test.ts"],
      blockedReason: "",
    };
    const { runner } = runnerReturning({
      code: 0,
      stdout: JSON.stringify({ result: JSON.stringify(payload) }),
      stderr: "",
      timedOut: false,
    });

    const outcome = await createExecutor(config, runner).execute(task, "/wt");

    expect(outcome).toEqual({ kind: "result", result: payload });
  });

  it("never passes an API key so the subscription is used", async () => {
    const { runner, run } = runnerReturning({
      code: 0,
      stdout: JSON.stringify({ result: '{"status":"completed","summary":"","filesChanged":[],"testsAdded":[],"blockedReason":""}' }),
      stderr: "",
      timedOut: false,
    });

    await createExecutor(config, runner).execute(task, "/wt");

    expect(run.mock.calls[0][2].env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("classifies a usage limit as its own outcome", async () => {
    const { runner } = runnerReturning({
      code: 1,
      stdout: "",
      stderr: "Claude usage limit reached. Your limit will reset at 3pm.",
      timedOut: false,
    });

    expect(await createExecutor(config, runner).execute(task, "/wt")).toEqual({ kind: "usage_limit" });
  });

  it("reports a timeout", async () => {
    const { runner } = runnerReturning({ code: -1, stdout: "", stderr: "", timedOut: true });
    expect(await createExecutor(config, runner).execute(task, "/wt")).toEqual({ kind: "timeout" });
  });

  it("reports unparseable output as an error", async () => {
    const { runner } = runnerReturning({ code: 0, stdout: "not json", stderr: "", timedOut: false });
    const outcome = await createExecutor(config, runner).execute(task, "/wt");
    expect(outcome.kind).toBe("error");
  });

  it("does not classify a completed result mentioning rate limiting as a usage limit", async () => {
    const payload = {
      status: "completed",
      summary: "Added rate limiting to the login endpoint",
      filesChanged: ["rate-limiter.ts"],
      testsAdded: ["rate-limiter.test.ts"],
      blockedReason: "",
    };
    const { runner } = runnerReturning({
      code: 0,
      stdout: JSON.stringify({ result: JSON.stringify(payload) }),
      stderr: "",
      timedOut: false,
    });

    const outcome = await createExecutor(config, runner).execute(task, "/wt");

    expect(outcome).toEqual({ kind: "result", result: payload });
  });

  it("reports a non-zero exit without a usage-limit phrase as a plain error", async () => {
    const { runner } = runnerReturning({ code: 1, stdout: "", stderr: "unexpected crash", timedOut: false });

    expect(await createExecutor(config, runner).execute(task, "/wt")).toEqual({
      kind: "error",
      message: "unexpected crash",
    });
  });

  it("recovers the envelope when claude prints noise before the JSON", async () => {
    const payload = { status: "completed", summary: "done", filesChanged: [], testsAdded: [], blockedReason: "" };
    const { runner } = runnerReturning({
      code: 0,
      stdout: `A new version of Claude Code is available.\n${JSON.stringify({ result: JSON.stringify(payload) })}`,
      stderr: "",
      timedOut: false,
    });

    const outcome = await createExecutor(config, runner).execute(task, "/wt");

    expect(outcome).toEqual({ kind: "result", result: payload });
  });

  it("accepts the result field as an object instead of a JSON string", async () => {
    const payload = { status: "completed", summary: "done", filesChanged: [], testsAdded: [], blockedReason: "" };
    const { runner } = runnerReturning({
      code: 0,
      stdout: JSON.stringify({ result: payload }),
      stderr: "",
      timedOut: false,
    });

    const outcome = await createExecutor(config, runner).execute(task, "/wt");

    expect(outcome).toEqual({ kind: "result", result: payload });
  });

  it("reports a schema-violating payload as an error instead of passing it through", async () => {
    const { runner } = runnerReturning({
      code: 0,
      stdout: JSON.stringify({ result: JSON.stringify({ status: "completed", summary: "done" }) }),
      stderr: "",
      timedOut: false,
    });

    const outcome = await createExecutor(config, runner).execute(task, "/wt");

    expect(outcome.kind).toBe("error");
  });

  it("tells the model the task text is untrusted data, not instructions to follow", async () => {
    const { runner, run } = runnerReturning({
      code: 0,
      stdout: JSON.stringify({ result: '{"status":"completed","summary":"","filesChanged":[],"testsAdded":[],"blockedReason":""}' }),
      stderr: "",
      timedOut: false,
    });

    await createExecutor(config, runner).execute(task, "/wt");

    const args = run.mock.calls[0][1] as string[];
    const flagIndex = args.indexOf("--append-system-prompt");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toMatch(/untrusted/i);
  });
});
