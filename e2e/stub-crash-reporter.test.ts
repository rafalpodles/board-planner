import { describe, it, expect, vi, afterEach } from "vitest";
import type { FullResult } from "@playwright/test/reporter";
import StubCrashReporter from "./stub-crash-reporter";
import { CRASH_MARKER, EXPECTED_CRASH_MARKER } from "./stub-guard.mjs";

/**
 * BP-581. What the reporter has to get right is not "does it grep": it is that a green run whose
 * only crash was the deliberate one stays green, and that a crash arriving in whatever chunks a
 * pipe happens to deliver is still found.
 */

const passed = { status: "passed" } as FullResult;

function summary() {
  return vi.mocked(process.stdout.write).mock.calls.map(([text]) => String(text)).join("");
}

afterEach(() => vi.restoreAllMocks());

function watching() {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  return new StubCrashReporter();
}

describe("reading the stubs' own output", () => {
  it("leaves a run alone when nothing crashed", async () => {
    const reporter = watching();
    reporter.onStdOut?.("webhook receiver listening on 4063\n");

    expect(await reporter.onEnd?.(passed)).toBeUndefined();
    expect(summary()).toBe("");
  });

  it("fails a run whose stub crashed, even when every test passed", async () => {
    const reporter = watching();
    reporter.onStdErr?.(`\n${CRASH_MARKER} [webhook receiver] POST /hook\nTypeError: no\n`);

    expect(await reporter.onEnd?.(passed)).toEqual({ status: "failed" });
    // Naming the stub is the point: a crash on a fire-and-forget path reads as a missing row
    expect(summary()).toContain("[webhook receiver] POST /hook");
    expect(summary()).toContain("1 stub crash");
  });

  it("keeps a run green when the only crash was the one a spec asked for", async () => {
    const reporter = watching();
    reporter.onStdErr?.(`\n${EXPECTED_CRASH_MARKER} [openrouter stub] POST /v1/chat/completions\n`);

    expect(await reporter.onEnd?.(passed)).toBeUndefined();
    expect(summary()).toBe("");
  });

  it("finds a marker split across two chunks", async () => {
    const reporter = watching();
    reporter.onStdErr?.(`\n${CRASH_MARKER.slice(0, 4)}`);
    reporter.onStdErr?.(`${CRASH_MARKER.slice(4)} [openai stub] GET /x\n`);

    expect(await reporter.onEnd?.(passed)).toEqual({ status: "failed" });
    expect(summary()).toContain("[openai stub] GET /x");
  });

  it("finds a crash on a last line that never got its newline", async () => {
    const reporter = watching();
    reporter.onStdErr?.(`${CRASH_MARKER} [mcp stub] GET /sse`);

    expect(await reporter.onEnd?.(passed)).toEqual({ status: "failed" });
    expect(summary()).toContain("[mcp stub] GET /sse");
  });

  it("does not turn an already-failed run into a passed one", async () => {
    const reporter = watching();
    reporter.onStdErr?.(`${CRASH_MARKER} [openai stub] GET /x\n`);

    expect(await reporter.onEnd?.({ status: "timedout" } as FullResult)).toEqual({
      status: "timedout",
    });
  });

  it("counts every crash, not only the first", async () => {
    const reporter = watching();
    reporter.onStdErr?.(`${CRASH_MARKER} [a] GET /1\n${CRASH_MARKER} [b] GET /2\n`);

    await reporter.onEnd?.(passed);

    expect(summary()).toContain("2 stub crashes");
  });
});
