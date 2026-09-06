import { readFileSync } from "fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createExecutor } from "./executor.js";
import { parseStream, StreamEvent } from "./stream.js";
import { claimedTask } from "./__fixtures__/task.js";
import { workerConfig } from "./__fixtures__/config.js";

const config = workerConfig();

const task = claimedTask({ description: "Do it well", acceptanceCriteria: ["works"] });

const options = {
  task,
  worktreePath: "/wt",
  brief: {
    prompt: "Make the change the task describes.",
    capability: "edit" as const,
    model: "",
    fallbackModel: "",
    timeoutMs: 1000,
  },
};

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

    const outcome = await createExecutor(config, runner).execute(options);

    expect(outcome).toEqual({ kind: "result", result: payload });
  });

  it("returns the result of a real captured run, whose stream carries an allowed_warning rate limit", async () => {
    expect(FIXTURE).toContain('"status":"allowed_warning"');
    const { runner } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    const outcome = await createExecutor(config, runner).execute(options);

    expect(outcome).toEqual({ kind: "result", result: FIXTURE_RESULT });
  });

  it("gives the implementer no shell", async () => {
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute(options);

    const args = run.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--tools") + 1]).toBe("Read Edit Write Grep Glob");
  });

  it("gives a read-only step no way to change anything", async () => {
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute({
      ...options,
      brief: { ...options.brief, capability: "read-only" },
    });

    const tools = (run.mock.calls[0][1] as string[])[
      (run.mock.calls[0][1] as string[]).indexOf("--tools") + 1
    ];
    expect(tools).toBe("Read Grep Glob");
    for (const forbidden of ["Edit", "Write", "Bash"]) {
      expect(tools.split(" ")).not.toContain(forbidden);
    }
  });

  it("keeps the untrusted-data framing ahead of the block's own prompt", async () => {
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute({
      ...options,
      brief: { ...options.brief, prompt: "tidy the imports" },
    });

    const args = run.mock.calls[0][1] as string[];
    const prompt = args[args.indexOf("--append-system-prompt") + 1];
    expect(prompt.indexOf("untrusted party")).toBeLessThan(prompt.indexOf("tidy the imports"));
  });

  it("tells the agent the worker commits, since it no longer can", async () => {
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute(options);

    const args = run.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--append-system-prompt") + 1]).toMatch(/Do not commit/);
  });

  it("asks the CLI for a stream, with the --verbose it refuses to stream without", async () => {
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute(options);

    const args = run.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
  });

  it("runs the model the policy names, not a hardcoded one", async () => {
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });
    const policyConfig = { ...config, model: "haiku", fallbackModel: "opus" };

    await createExecutor(policyConfig, runner).execute(options);

    const args = run.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--fallback-model") + 1]).toBe("opus");
  });

  it("falls back to the models it has always used when the policy names none", async () => {
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute(options);

    const args = run.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--fallback-model") + 1]).toBe("sonnet");
  });

  it("never hands the CLI an empty model flag", async () => {
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });
    const blank = { ...config, model: "   ", fallbackModel: "" };

    await createExecutor(blank, runner).execute(options);

    const args = run.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--fallback-model") + 1]).toBe("sonnet");
    expect(args).not.toContain("");
  });

  it("never passes an API key so the subscription is used", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const { runner, run } = runnerReturning({
      code: 0,
      stdout: completed(FIXTURE_RESULT),
      stderr: "",
      timedOut: false,
    });

    await createExecutor(config, runner).execute(options);

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

    expect(await createExecutor(config, runner).execute(options)).toEqual({ kind: "usage_limit" });
  });

  it("reports a timeout", async () => {
    const { runner } = runnerReturning({ code: -1, stdout: "", stderr: "", timedOut: true });
    expect(await createExecutor(config, runner).execute(options)).toEqual({ kind: "timeout" });
  });

  it("reports unparseable output as an error", async () => {
    const { runner } = runnerReturning({ code: 0, stdout: "not json", stderr: "", timedOut: false });
    const outcome = await createExecutor(config, runner).execute(options);
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

    const outcome = await createExecutor(config, runner).execute(options);

    expect(outcome).toEqual({ kind: "result", result: payload });
  });

  it("classifies an exit-0 usage-limit response as its own outcome", async () => {
    const { runner } = runnerReturning({
      code: 0,
      stdout: stream({ type: "result", result: "Claude AI usage limit reached|1735689600" }),
      stderr: "",
      timedOut: false,
    });

    expect(await createExecutor(config, runner).execute(options)).toEqual({ kind: "usage_limit" });
  });

  it("still classifies it when the CLI does declare the error", async () => {
    const { runner } = runnerReturning({
      code: 0,
      stdout: stream(
        resultEvent({ subtype: "error_during_execution", is_error: true, result: "Claude usage limit reached|1735689600" })
      ),
      stderr: "",
      timedOut: false,
    });

    expect(await createExecutor(config, runner).execute(options)).toEqual({ kind: "usage_limit" });
  });

  it("does not take the agent's own prose about usage limits as a usage limit", async () => {
    const { runner } = runnerReturning({
      code: 0,
      stdout: stream(
        resultEvent({
          subtype: "error_max_turns",
          is_error: true,
          result: "I reworked the usage limit reached detection but ran out of turns.",
        })
      ),
      stderr: "",
      timedOut: false,
    });

    const outcome = await createExecutor(config, runner).execute(options);
    expect(outcome.kind).toBe("error");
  });

  it("keeps a run that finished on the fallback model after the CLI announced a limit", async () => {
    const payload = {
      status: "completed",
      summary: "Added the missing guard",
      filesChanged: ["src/a.ts"],
      testsAdded: ["src/a.test.ts"],
      blockedReason: "",
    };
    const { runner } = runnerReturning({
      code: 0,
      stdout: completed(payload),
      stderr: "Claude usage limit reached. Falling back to sonnet.",
      timedOut: false,
    });

    expect(await createExecutor(config, runner).execute(options)).toEqual({ kind: "result", result: payload });
  });

  it("does not take a successful run's summary about usage limits as a usage limit", async () => {
    const payload = {
      status: "completed",
      summary: "Reworked how the executor detects a usage limit reached response",
      filesChanged: ["worker/src/executor.ts"],
      testsAdded: ["worker/src/executor.test.ts"],
      blockedReason: "",
    };
    const { runner } = runnerReturning({ code: 0, stdout: completed(payload), stderr: "", timedOut: false });

    expect(await createExecutor(config, runner).execute(options)).toEqual({ kind: "result", result: payload });
  });

  it("classifies a rejected rate_limit_event as a usage limit", async () => {
    const { runner } = runnerReturning({
      code: 0,
      stdout: fixtureWithRateLimitStatus("rejected"),
      stderr: "",
      timedOut: false,
    });

    expect(await createExecutor(config, runner).execute(options)).toEqual({ kind: "usage_limit" });
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

    expect(await createExecutor(config, runner).execute(options)).toEqual({
      kind: "result",
      result: FIXTURE_RESULT,
    });
  });

  it("does not read a usage limit out of file content the agent looked at", async () => {
    const stdout = fixtureWithToolResult(
      "1\tfunction isUsageLimit(text: string): boolean {\n2\t  return /usage limit reached/i.test(text);\n3\t}"
    );
    expect(stdout).toContain("usage limit reached");
    const { runner } = runnerReturning({ code: 0, stdout, stderr: "", timedOut: false });

    const outcome = await createExecutor(config, runner).execute(options);

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

    const outcome = await createExecutor(config, runner).execute(options);

    expect(outcome).toEqual({ kind: "result", result: payload });
  });

  it("reports a non-zero exit without a usage-limit phrase as a plain error", async () => {
    const { runner } = runnerReturning({ code: 1, stdout: "", stderr: "unexpected crash", timedOut: false });

    expect(await createExecutor(config, runner).execute(options)).toEqual({
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

    const outcome = await createExecutor(config, runner).execute(options);

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

    const outcome = await createExecutor(config, runner).execute(options);

    expect(outcome).toEqual({ kind: "result", result: payload });
  });

  it("reports a schema-violating payload as an error instead of passing it through", async () => {
    const { runner } = runnerReturning({
      code: 0,
      stdout: completed({ status: "completed", summary: "done" }),
      stderr: "",
      timedOut: false,
    });

    const outcome = await createExecutor(config, runner).execute(options);

    expect(outcome.kind).toBe("error");
  });

  it("passes the abort signal through to the runner, so a stop can reach the run in flight", async () => {
    const controller = new AbortController();
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute({ ...options, signal: controller.signal });

    expect(run.mock.calls[0][2].signal).toBe(controller.signal);
  });

  it("tells the model the task text is untrusted data, not instructions to follow", async () => {
    const { runner, run } = runnerReturning({
      code: 0,
      stdout: completed(FIXTURE_RESULT),
      stderr: "",
      timedOut: false,
    });

    await createExecutor(config, runner).execute(options);

    const args = run.mock.calls[0][1] as string[];
    const flagIndex = args.indexOf("--append-system-prompt");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toMatch(/untrusted/i);
  });
});

describe("reporting the stream as it arrives", () => {
  type Opts = { onStdout?: (chunk: string) => void };

  function fixedChunks(text: string, size: number): string[] {
    const parts: string[] = [];
    for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
    return parts;
  }

  function chunkedRunner(stdout: string, parts: string[]) {
    const run = vi.fn(async (_command: string, _args: string[], opts: Opts) => {
      for (const part of parts) opts.onStdout?.(part);
      return { code: 0, stdout, stderr: "", timedOut: false };
    });
    return { runner: { run } as never, run };
  }

  it.each([1, 3, 17, 512, 1_000_000])(
    "reports the same events as a whole-output parse when the pipe flushes every %i bytes",
    async (size) => {
      const seen: StreamEvent[] = [];
      const { runner } = chunkedRunner(FIXTURE, fixedChunks(FIXTURE, size));

      await createExecutor(config, runner).execute({ ...options, onEvent: (event) => seen.push(event) });

      expect(seen).toEqual(parseStream(FIXTURE));
    }
  );

  it("holds a line back until the chunk carrying the rest of it arrives", async () => {
    const stream = `${JSON.stringify({ type: "system", subtype: "init" })}\n`;
    const cut = Math.floor(stream.length / 2);
    const seen: StreamEvent[] = [];
    let reportedAfterTheFirstHalf = -1;

    const run = vi.fn(async (_command: string, _args: string[], opts: Opts) => {
      opts.onStdout?.(stream.slice(0, cut));
      reportedAfterTheFirstHalf = seen.length;
      opts.onStdout?.(stream.slice(cut));
      return { code: 0, stdout: stream, stderr: "", timedOut: false };
    });

    await createExecutor(config, { run } as never).execute({ ...options, onEvent: (event) => seen.push(event) });

    expect(reportedAfterTheFirstHalf).toBe(0);
    expect(seen).toEqual([{ type: "system", subtype: "init" }]);
  });

  it("gives up on a single line too large to be telemetry, then resynchronises", async () => {
    const enormous = `${JSON.stringify({ type: "system", subtype: "init", pad: "x".repeat(1_200_000) })}\n`;
    const good = `${JSON.stringify({ type: "system", subtype: "compact_boundary" })}\n`;
    const seen: StreamEvent[] = [];

    const run = vi.fn(async (_c: string, _a: string[], opts: Opts) => {
      for (const piece of fixedChunks(enormous, 256 * 1024)) opts.onStdout?.(piece);
      opts.onStdout?.(good);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    });

    await createExecutor(config, { run } as never).execute({ ...options, onEvent: (event) => seen.push(event) });

    expect(seen).toEqual([{ type: "system", subtype: "compact_boundary" }]);
  });

  it("reports a final line that never got its newline", async () => {
    const stream = JSON.stringify({ type: "system", subtype: "init" });
    const seen: StreamEvent[] = [];
    const { runner } = chunkedRunner(stream, [stream]);

    await createExecutor(config, runner).execute({ ...options, onEvent: (event) => seen.push(event) });

    expect(seen).toEqual([{ type: "system", subtype: "init" }]);
  });

  it("stops reporting once the run has settled, so a late chunk cannot describe a finished task", async () => {
    const seen: StreamEvent[] = [];
    let late: ((chunk: string) => void) | undefined;
    const run = vi.fn(async (_command: string, _args: string[], opts: Opts) => {
      late = opts.onStdout;
      return { code: 0, stdout: completed(FIXTURE_RESULT), stderr: "", timedOut: false };
    });

    await createExecutor(config, { run } as never).execute({ ...options, onEvent: (event) => seen.push(event) });

    expect(late).toBeDefined();
    late?.(`${JSON.stringify({ type: "system", subtype: "late" })}\n`);

    expect(seen).toEqual([]);
  });

  it("asks for no incremental stdout at all when nobody is listening", async () => {
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute(options);

    expect(run.mock.calls[0][2].onStdout).toBeUndefined();
  });
});

describe("the environment handed to the agent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("carries no credential from the worker's own process", async () => {
    vi.stubEnv("CP_API_TOKEN", "cp_secret");
    vi.stubEnv("GH_TOKEN", "gho_secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret");
    const { runner, run } = runnerReturning({ code: 0, stdout: FIXTURE, stderr: "", timedOut: false });

    await createExecutor(config, runner).execute(options);

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

    await createExecutor(config, runner).execute(options);

    const env = run.mock.calls[0][2].env;
    expect(env.HOME).toBe("/Users/rpo");
    expect(env.PATH).toBe("/usr/bin");
  });
});
