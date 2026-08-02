import { readFileSync } from "fs";
import { describe, it, expect, vi, afterEach } from "vitest";
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

// a real `claude -p --output-format stream-json --verbose` run, captured verbatim
const FIXTURE = readFileSync(new URL("./__fixtures__/stream-success.ndjson", import.meta.url), "utf8");

const FIXTURE_RESULT = {
  status: "completed",
  summary: "Changed the value 41 to 42 in sample.ts.",
  filesChanged: ["sample.ts"],
  testsAdded: [],
  blockedReason: "",
};

type Event = Record<string, unknown>;

function stream(...events: Event[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function resultEvent(fields: Event): Event {
  return { type: "result", subtype: "success", is_error: false, ...fields };
}

function completed(payload: unknown): string {
  return stream({ type: "system", subtype: "init" }, resultEvent({ result: JSON.stringify(payload) }));
}

function fixtureEvents(): Event[] {
  return FIXTURE.split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Event);
}

function isRecord(value: unknown): value is Event {
  return typeof value === "object" && value !== null;
}

function fixtureWithToolResult(content: string): string {
  const events = fixtureEvents();
  for (const event of events) {
    const blocks = isRecord(event.message) ? event.message.content : undefined;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (isRecord(block) && block.type === "tool_result") block.content = content;
    }
  }
  return stream(...events);
}

function fixtureWithRateLimitStatus(status: string): string {
  const events = fixtureEvents();
  for (const event of events) {
    if (event.type === "rate_limit_event" && isRecord(event.rate_limit_info)) {
      event.rate_limit_info.status = status;
    }
  }
  return stream(...events);
}

function runnerReturning(result: Record<string, unknown>) {
  const run = vi.fn().mockResolvedValue(result);
  return { runner: { run }, run };
}

describe("createExecutor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses a schema-conforming result", async () => {
    const payload = {
      status: "completed",
      summary: "done",
      filesChanged: ["a.ts"],
      testsAdded: ["a.test.ts"],
      blockedReason: "",
    };
    const { runner } = runnerReturning({ code: 0, stdout: completed(payload), stderr: "", timedOut: false });

    const outcome = await createExecutor(config, runner).execute(task, "/wt");

    expect(outcome).toEqual({ kind: "result", result: payload });
  });

  it("returns the result of a real captured run, whose stream carries an allowed_warning rate limit", async () => {
    expect(FIXTURE).toContain('"status":"allowed_warning"');
    const { runner } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    const outcome = await createExecutor(config, runner).execute(task, "/wt");

    expect(outcome).toEqual({ kind: "result", result: FIXTURE_RESULT });
  });

  it("asks the CLI for a stream, with the --verbose it refuses to stream without", async () => {
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute(task, "/wt");

    const args = run.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
  });

  it("never passes an API key so the subscription is used", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const { runner, run } = runnerReturning({
      code: 0,
      stdout: completed(FIXTURE_RESULT),
      stderr: "",
      timedOut: false,
    });

    await createExecutor(config, runner).execute(task, "/wt");

    expect(run.mock.calls[0][2].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(run.mock.calls[0][2].env.PATH).toBe(process.env.PATH);
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
    const { runner } = runnerReturning({ code: 0, stdout: completed(payload), stderr: "", timedOut: false });

    const outcome = await createExecutor(config, runner).execute(task, "/wt");

    expect(outcome).toEqual({ kind: "result", result: payload });
  });

  it("classifies an exit-0 usage-limit response as its own outcome", async () => {
    const { runner } = runnerReturning({
      code: 0,
      stdout: stream(resultEvent({ is_error: true, result: "Claude AI usage limit reached|1735689600" })),
      stderr: "",
      timedOut: false,
    });

    expect(await createExecutor(config, runner).execute(task, "/wt")).toEqual({ kind: "usage_limit" });
  });

  it("classifies a rejected rate_limit_event as a usage limit", async () => {
    const { runner } = runnerReturning({
      code: 0,
      stdout: fixtureWithRateLimitStatus("rejected"),
      stderr: "",
      timedOut: false,
    });

    expect(await createExecutor(config, runner).execute(task, "/wt")).toEqual({ kind: "usage_limit" });
  });

  it("treats an allowed_warning rate_limit_event as normal, so a 75% run is not stalled", async () => {
    const { runner } = runnerReturning({
      code: 0,
      stdout: stream(
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed_warning", utilization: 0.76, rateLimitType: "seven_day" },
        },
        resultEvent({ result: JSON.stringify(FIXTURE_RESULT) })
      ),
      stderr: "",
      timedOut: false,
    });

    expect(await createExecutor(config, runner).execute(task, "/wt")).toEqual({
      kind: "result",
      result: FIXTURE_RESULT,
    });
  });

  // stdout carries the content of every file the agent read, and the phrase lives in this
  // repository's own source — reading it back must not look like a usage limit, or a task touching
  // the worker refunds its attempt and the loop retries it immediately, for free, forever
  it("does not read a usage limit out of file content the agent looked at", async () => {
    const stdout = fixtureWithToolResult(
      "1\tfunction isUsageLimit(text: string): boolean {\n2\t  return /usage limit reached/i.test(text);\n3\t}"
    );
    expect(stdout).toContain("usage limit reached");
    const { runner } = runnerReturning({ code: 0, stdout, stderr: "", timedOut: false });

    const outcome = await createExecutor(config, runner).execute(task, "/wt");

    expect(outcome).toEqual({ kind: "result", result: FIXTURE_RESULT });
  });

  it("does not classify a completed result mentioning rate limiting as a usage limit when the process exits non-zero for an unrelated reason", async () => {
    const payload = {
      status: "completed",
      summary: "Added rate limiting to the login endpoint",
      filesChanged: ["rate-limiter.ts"],
      testsAdded: ["rate-limiter.test.ts"],
      blockedReason: "",
    };
    const { runner } = runnerReturning({
      code: 1,
      stdout: completed(payload),
      stderr: "post-task cleanup hook exited with status 1",
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

  it("recovers the result when claude prints noise before the stream", async () => {
    const payload = { status: "completed", summary: "done", filesChanged: [], testsAdded: [], blockedReason: "" };
    const { runner } = runnerReturning({
      code: 0,
      stdout: `A new version of Claude Code is available.\n${completed(payload)}`,
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
      stdout: stream(resultEvent({ result: payload })),
      stderr: "",
      timedOut: false,
    });

    const outcome = await createExecutor(config, runner).execute(task, "/wt");

    expect(outcome).toEqual({ kind: "result", result: payload });
  });

  it("reports a schema-violating payload as an error instead of passing it through", async () => {
    const { runner } = runnerReturning({
      code: 0,
      stdout: completed({ status: "completed", summary: "done" }),
      stderr: "",
      timedOut: false,
    });

    const outcome = await createExecutor(config, runner).execute(task, "/wt");

    expect(outcome.kind).toBe("error");
  });

  it("passes the abort signal through to the runner, so a stop can reach the run in flight", async () => {
    const controller = new AbortController();
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute(task, "/wt", controller.signal);

    expect(run.mock.calls[0][2].signal).toBe(controller.signal);
  });

  it("tells the model the task text is untrusted data, not instructions to follow", async () => {
    const { runner, run } = runnerReturning({
      code: 0,
      stdout: completed(FIXTURE_RESULT),
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

describe("the environment handed to the agent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The agent runs with bypassPermissions and has Bash. Anything in this environment is
  // something it can read and use — CP_API_TOKEN would let it write to the board as the operator
  it("carries no credential from the worker's own process", async () => {
    vi.stubEnv("CP_API_TOKEN", "cp_secret");
    vi.stubEnv("GH_TOKEN", "gho_secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret");
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute(task, "/wt");

    const env = run.mock.calls[0][2].env;
    expect(env.CP_API_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.values(env)).not.toContain("cp_secret");
  });

  it("still carries what the CLI needs to find its logged-in session", async () => {
    vi.stubEnv("HOME", "/Users/rpo");
    vi.stubEnv("PATH", "/usr/bin");
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute(task, "/wt");

    const env = run.mock.calls[0][2].env;
    expect(env.HOME).toBe("/Users/rpo");
    expect(env.PATH).toBe("/usr/bin");
  });
});
