import { readFileSync } from "fs";
import { describe, it, expect, vi } from "vitest";
import { parseStream, StreamEvent } from "./stream.js";
import {
  createTelemetry,
  dropWhenBusy,
  isOutcome,
  isQuota,
  Progress,
  summarise,
  TelemetryUpdate,
} from "./telemetry.js";

const FIXTURE = readFileSync(new URL("./__fixtures__/stream-success.ndjson", import.meta.url), "utf8");

const SECRET = "cpw_deadbeef0123456789abcdef01234567";

// The envelope of a real assistant event, verbatim from the fixture except for the content blocks.
function assistantEvent(content: unknown[]): StreamEvent {
  return {
    type: "assistant",
    message: {
      model: "claude-sonnet-5",
      id: "msg_011CdeMN5WMGasEc88hb1DEx",
      type: "message",
      role: "assistant",
      content,
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 2, output_tokens: 62, service_tier: "standard" },
      diagnostics: null,
      context_management: null,
    },
    parent_tool_use_id: null,
    session_id: "0c8cd177-0341-4880-8bea-490d0c9702a4",
    uuid: "f49f5415-1fee-4aee-a8c6-86f40884581d",
    timestamp: "2026-08-02T17:55:36.906Z",
    request_id: "req_011CdeMN1y2WJpWLNLEXak1q",
  } as StreamEvent;
}

function toolUse(name: string, input: unknown): unknown {
  return { type: "tool_use", id: "toolu_01CX5PsHEKkCDexGRYp8eyr6", name, input, caller: { type: "direct" } };
}

function rateLimitEvent(info: unknown): StreamEvent {
  return {
    type: "rate_limit_event",
    rate_limit_info: info,
    uuid: "3a5cb140-7162-4738-bc52-de1a9d0631bd",
    session_id: "0c8cd177-0341-4880-8bea-490d0c9702a4",
  } as StreamEvent;
}

describe("summarise — what a tool call is allowed to reveal", () => {
  it("keeps the tool name and the path, and drops everything else in the input", () => {
    const event = assistantEvent([
      toolUse("Edit", {
        replace_all: false,
        file_path: "x.ts",
        content: `TOKEN=${SECRET}`,
        old_string: `const token = "${SECRET}";`,
        new_string: "const token = process.env.TOKEN;",
      }),
    ]);

    const result = summarise(event);

    expect(result).toEqual({ phase: "agent", tool: { name: "Edit", target: "x.ts" } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("process.env.TOKEN");
  });

  it("takes only the executable from a command, never its arguments", () => {
    const event = assistantEvent([
      toolUse("Bash", { command: `  git push https://x-access-token:${SECRET}@github.com/o/r `, timeout: 120000 }),
    ]);

    const result = summarise(event);

    expect(result).toEqual({ phase: "agent", tool: { name: "Bash", target: "git" } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("reads the target from each whitelisted key", () => {
    const cases: Array<{ input: Record<string, unknown>; target: string | undefined }> = [
      { input: { file_path: "src/a.ts" }, target: "src/a.ts" },
      { input: { path: "src/b" }, target: "src/b" },
      { input: { command: "npm run build" }, target: "npm" },
      { input: { prompt: "leak me", description: "leak me", url: "https://evil" }, target: undefined },
      { input: { pattern: `grep for ${SECRET}` }, target: undefined },
      { input: {}, target: undefined },
    ];

    for (const { input, target } of cases) {
      const result = summarise(assistantEvent([toolUse("Tool", input)])) as Progress;
      expect(result.tool, JSON.stringify(input)).toEqual(target === undefined ? { name: "Tool" } : { name: "Tool", target });
    }
  });

  // Naming the key is not enough: the tool_use block is summarised whether or not the call then
  // failed, so an agent can put anything in file_path and never care that it does not resolve
  it("refuses a file_path that is really a file body", () => {
    const body = `const token = "${SECRET}";\nexport const answer = 41;\n`;
    const event = assistantEvent([toolUse("Read", { file_path: body })]);

    const result = summarise(event);

    expect(result).toEqual({ phase: "agent", tool: { name: "Read" } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("refuses a path longer than any real path", () => {
    const event = assistantEvent([toolUse("Read", { file_path: `src/${"a".repeat(200)}.ts` })]);

    expect(summarise(event)).toEqual({ phase: "agent", tool: { name: "Read" } });
  });

  // `FOO=secret npm run build` is ordinary debugging behaviour, and this repo's CLAUDE.md documents
  // exactly which variables an agent would prefix
  it("refuses an env-var prefix standing where the executable should be", () => {
    const event = assistantEvent([toolUse("Bash", { command: `MONGODB_URI=mongodb+srv://u:${SECRET}@host npm run build` })]);

    const result = summarise(event);

    expect(result).toEqual({ phase: "agent", tool: { name: "Bash" } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("reduces an absolute command to its executable", () => {
    const event = assistantEvent([toolUse("Bash", { command: "/usr/local/bin/npm run build" })]);

    expect(summarise(event)).toEqual({ phase: "agent", tool: { name: "Bash", target: "npm" } });
  });

  it("refuses a tool name that is not a tool name", () => {
    const event = assistantEvent([toolUse(`leak ${SECRET}`, { file_path: "src/a.ts" })]);

    const result = summarise(event);

    expect(result).toBeNull();
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("ignores a whitelisted key whose value is not a string", () => {
    const event = assistantEvent([toolUse("Read", { file_path: { nested: SECRET }, path: ["a", SECRET] })]);

    const result = summarise(event);

    expect(result).toEqual({ phase: "agent", tool: { name: "Read" } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("reports the last tool of a message that calls several", () => {
    const event = assistantEvent([
      toolUse("Read", { file_path: "first.ts" }),
      toolUse("Grep", { pattern: "second" }),
    ]);

    expect(summarise(event)).toEqual({ phase: "agent", tool: { name: "Grep" } });
  });

  it("says nothing about a message that only thinks or talks", () => {
    expect(summarise(assistantEvent([{ type: "text", text: `the token is ${SECRET}` }]))).toBeNull();
    expect(summarise(assistantEvent([{ type: "thinking", thinking: SECRET, signature: SECRET }]))).toBeNull();
    expect(summarise(assistantEvent([]))).toBeNull();
  });

  it("says nothing about a tool result, which is where read file bodies arrive", () => {
    const event = {
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: "toolu_01", type: "tool_result", content: `1\tconst token = "${SECRET}";\n` }],
      },
      tool_use_result: { filePath: "x.ts", content: SECRET },
      session_id: "0c8cd177",
      uuid: "b9b0",
    } as StreamEvent;

    expect(summarise(event)).toBeNull();
  });

  it("says nothing about a system event or an event type it has never seen", () => {
    expect(summarise({ type: "system", subtype: "init" })).toBeNull();
    expect(summarise({ type: "invented_in_a_later_cli" })).toBeNull();
  });
});

describe("summarise — result events", () => {
  it("takes the turn count and the cost, and leaves the payload behind", () => {
    const event = {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 4,
      total_cost_usd: 0.479847,
      result: `{"status":"completed","summary":"pasted ${SECRET} into the config"}`,
      structured_output: { status: "completed", summary: `pasted ${SECRET} into the config` },
    } as StreamEvent;

    const result = summarise(event);

    expect(result).toEqual({ phase: "agent", turns: 4, costUsd: 0.479847 });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("omits numbers the event did not carry rather than reporting zero", () => {
    expect(summarise({ type: "result" })).toEqual({ phase: "agent", turns: undefined, costUsd: undefined });
  });
});

describe("summarise — rate limit events", () => {
  it("maps the warning from the real run to a quota reading", () => {
    const warning = parseStream(FIXTURE).find((e) => e.type === "rate_limit_event")!;

    expect(summarise(warning)).toEqual({
      status: "allowed_warning",
      utilization: 0.76,
      resetsAt: 1785844800,
      rateLimitType: "seven_day",
    });
  });

  it("maps a rejection without deciding what it means", () => {
    const event = rateLimitEvent({ status: "rejected", resetsAt: 1785844800, rateLimitType: "seven_day", utilization: 1 });

    expect(summarise(event)).toEqual({
      status: "rejected",
      utilization: 1,
      resetsAt: 1785844800,
      rateLimitType: "seven_day",
    });
  });

  it("drops a reading it cannot classify", () => {
    expect(summarise(rateLimitEvent({ status: "throttled_in_a_later_cli", utilization: 1 }))).toBeNull();
    expect(summarise(rateLimitEvent({ utilization: 1 }))).toBeNull();
    expect(summarise({ type: "rate_limit_event" })).toBeNull();
  });
});

describe("summarise — over the whole captured run", () => {
  const summaries = parseStream(FIXTURE).map(summarise);

  it("summarises each event of the real transcript", () => {
    const editedFile =
      "/private/tmp/claude-502/-Users-rpo-Documents-Projects-ClaudePlanner/11f74b5f-f0b9-4e31-936d-f02716080dcb/scratchpad/capture/sample.ts";

    expect(summaries).toEqual([
      null,
      null,
      { phase: "agent", tool: { name: "Read", target: editedFile } },
      { status: "allowed_warning", utilization: 0.76, resetsAt: 1785844800, rateLimitType: "seven_day" },
      null,
      { phase: "agent", tool: { name: "Edit", target: editedFile } },
      null,
      null,
      { phase: "agent", tool: { name: "StructuredOutput" } },
      null,
      { phase: "agent", turns: 4, costUsd: 0.47984699999999997 },
    ]);
  });

  it("carries none of the file content, thinking or agent prose the transcript contains", () => {
    const serialised = JSON.stringify(summaries);

    expect(FIXTURE).toContain("export const answer = 41;");
    expect(serialised).not.toContain("export const answer");

    expect(FIXTURE).toContain("Changed the value 41 to 42 in sample.ts.");
    expect(serialised).not.toContain("Changed the value 41 to 42");

    expect(serialised).not.toContain("ErsKCokBCBAYAipApywU5mvLA");
    expect(serialised).not.toContain("thinking");
  });
});

describe("createTelemetry", () => {
  const progress = (phase: Progress["phase"]): Progress => ({ phase });

  it("delivers updates to subscribers until they unsubscribe", () => {
    const telemetry = createTelemetry();
    const seen: TelemetryUpdate[] = [];
    const unsubscribe = telemetry.subscribe((update) => seen.push(update));

    telemetry.emit(progress("worktree"));
    unsubscribe();
    telemetry.emit(progress("merge"));

    expect(seen).toEqual([{ phase: "worktree" }]);
  });

  it("summarises a stream event before publishing it, and publishes nothing for events with no summary", () => {
    const telemetry = createTelemetry();
    const seen: TelemetryUpdate[] = [];
    telemetry.subscribe((update) => seen.push(update));

    for (const event of parseStream(FIXTURE)) telemetry.emitEvent(event);

    expect(seen).toHaveLength(5);
    expect(seen.filter(isQuota)).toEqual([
      { status: "allowed_warning", utilization: 0.76, resetsAt: 1785844800, rateLimitType: "seven_day" },
    ]);
    expect(JSON.stringify(seen)).not.toContain("export const answer");
  });

  it("replays recent progress in order and keeps only the newest 50", () => {
    const telemetry = createTelemetry();

    for (let i = 0; i < 53; i += 1) telemetry.emit({ phase: `gates:${i}` });

    const recent = telemetry.recent();
    expect(recent).toHaveLength(50);
    expect(recent[0]).toEqual({ phase: "gates:3" });
    expect(recent[49]).toEqual({ phase: "gates:52" });
  });

  it("keeps quota readings out of the progress replay", () => {
    const telemetry = createTelemetry();

    telemetry.emit({ status: "allowed_warning", utilization: 0.76 });
    telemetry.emit(progress("agent"));

    expect(telemetry.recent()).toEqual([{ phase: "agent" }]);
  });

  it("hands out a copy of the replay buffer", () => {
    const telemetry = createTelemetry();
    telemetry.emit(progress("agent"));

    telemetry.recent().push(progress("merge"));

    expect(telemetry.recent()).toEqual([{ phase: "agent" }]);
  });

  it("survives a subscriber that throws, and still reaches the others", () => {
    const telemetry = createTelemetry();
    const seen: TelemetryUpdate[] = [];
    telemetry.subscribe(() => {
      throw new Error("sink is down");
    });
    telemetry.subscribe((update) => seen.push(update));

    expect(() => telemetry.emit(progress("push"))).not.toThrow();
    expect(seen).toEqual([{ phase: "push" }]);
  });
});

describe("outcome updates", () => {
  it("discriminates an outcome from a progress and a quota", () => {
    expect(isOutcome({ outcome: "merged", taskKey: "CP-1" })).toBe(true);
    expect(isOutcome({ phase: "agent" })).toBe(false);
    expect(isOutcome({ status: "allowed" })).toBe(false);
  });

  it("is not mistaken for a quota, which would silence it on the socket", () => {
    expect(isQuota({ outcome: "merged", taskKey: "CP-1" })).toBe(false);
  });

  it("keeps outcomes out of the recent ring, which is progress only", () => {
    const telemetry = createTelemetry();

    telemetry.emit({ phase: "agent" });
    telemetry.emit({ outcome: "merged", taskKey: "CP-1" });

    expect(telemetry.recent()).toEqual([{ phase: "agent" }]);
  });

  it("delivers an outcome to subscribers", () => {
    const telemetry = createTelemetry();
    const seen: TelemetryUpdate[] = [];
    telemetry.subscribe((update) => seen.push(update));

    telemetry.emit({ outcome: "gateRejected", taskKey: "CP-1", detail: "build" });

    expect(seen).toEqual([{ outcome: "gateRejected", taskKey: "CP-1", detail: "build" }]);
  });

  it("carries the task key on a progress update, so the panel can name what is running", () => {
    const telemetry = createTelemetry();

    telemetry.emit({ phase: "agent", taskKey: "CP-161" });

    expect(telemetry.recent()).toEqual([{ phase: "agent", taskKey: "CP-161" }]);
  });
});

describe("dropWhenBusy", () => {
  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("drops updates while a send is in flight instead of queueing them", async () => {
    let release = (): void => {};
    const send = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const listener = dropWhenBusy(send);

    listener({ phase: "agent" });
    listener({ phase: "push" });
    listener({ phase: "pr" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ phase: "agent" });

    release();
    await flush();
    listener({ phase: "merge" });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ phase: "merge" });
  });

  it("swallows a failing send without an unhandled rejection, and accepts the next update", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const send = vi.fn().mockRejectedValueOnce(new Error("server down")).mockResolvedValueOnce(undefined);
      const listener = dropWhenBusy(send);

      listener({ phase: "agent" });
      await flush();
      listener({ phase: "merge" });
      await flush();

      expect(rejections).toEqual([]);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("swallows a send that throws before it returns a promise", async () => {
    const send = vi.fn(() => {
      throw new Error("bad url");
    });
    const listener = dropWhenBusy(send);

    expect(() => listener({ phase: "agent" })).not.toThrow();
    await flush();
    listener({ phase: "merge" });

    expect(send).toHaveBeenCalledTimes(2);
  });
});
