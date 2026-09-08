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

/** Playwright's own, dimmed exactly as `prefixOutputLines` emits it */
const PREFIX = "\u001b[2m[WebServer] \u001b[22m";

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
    // stdout, not stderr: a stub's own `console.log` and the dev server's lines come that way,
    // and a reader wired to only one of the two is half a reader
    reporter.onStdOut?.(`\n${CRASH_MARKER} [webhook receiver] POST /hook\nTypeError: no\n`);

    expect(await reporter.onEnd?.(passed)).toEqual({ status: "failed" });
    // Naming the stub is the point: a crash on a fire-and-forget path reads as a missing row
    expect(summary()).toContain("[webhook receiver] POST /hook");
    expect(summary()).toContain("1 stub crash.");
  });

  it("keeps a run green when the only crash was the one a spec asked for", async () => {
    const reporter = watching();
    reporter.onStdErr?.(`\n${EXPECTED_CRASH_MARKER} [openrouter stub] POST /v1/chat/completions\n`);

    expect(await reporter.onEnd?.(passed)).toBeUndefined();
    expect(summary()).toBe("");
  });

  // The chunks are shaped the way Playwright delivers them: `prefixOutputLines` puts `[WebServer] `
  // on every line of every chunk, the resumption of a split line included — so the marker comes
  // back with the prefix inside it unless that is taken out first.
  it("finds a marker split across two chunks, prefixed the way Playwright prefixes them", async () => {
    const reporter = watching();
    reporter.onStdErr?.(`${PREFIX}\n${PREFIX}${CRASH_MARKER.slice(0, 4)}`);
    reporter.onStdErr?.(`${PREFIX}${CRASH_MARKER.slice(4)} [openai stub] GET /x\n`);

    expect(await reporter.onEnd?.(passed)).toEqual({ status: "failed" });
    expect(summary()).toContain("[openai stub] GET /x");
    expect(summary(), "the pipe's own prefix is not part of the report").not.toContain("[WebServer]");
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

  // `stub-guard`'s own docblock records a measured storm of 25,852 reports in under a second;
  // holding every line of that in the runner is no better than dropping them all
  it("counts a storm without printing all of it", async () => {
    const reporter = watching();
    for (let i = 0; i < 50; i++) reporter.onStdErr?.(`${CRASH_MARKER} [a] GET /${i}\n`);

    await reporter.onEnd?.(passed);

    expect(summary(), "the count is the true one").toContain("50 stub crashes");
    expect(summary().split("\n").filter((line) => line.includes("GET /")).length).toBe(20);
    expect(summary()).toContain("…and 30 more");
  });

  // The two streams interleave, and one buffer would glue an unfinished stdout line onto the next
  // stderr chunk — here that splice spells the marker neither stream ever wrote
  it("keeps a half-line on each stream to itself", async () => {
    const reporter = watching();
    reporter.onStdOut?.(`${PREFIX}compiled /projects — ${CRASH_MARKER.slice(0, 5)}`);
    reporter.onStdErr?.(`${PREFIX}${CRASH_MARKER.slice(5)} is not what this line says\n`);

    expect(await reporter.onEnd?.(passed), "no crash was reported by either stream").toBeUndefined();
    expect(summary()).toBe("");
  });
});
