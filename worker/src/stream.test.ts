import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import { lastResultEvent, parseStream, ResultEvent } from "./stream.js";

const FIXTURE = readFileSync(new URL("./__fixtures__/stream-success.ndjson", import.meta.url), "utf8");

describe("parseStream", () => {
  it("reads every event of a real captured run", () => {
    const events = parseStream(FIXTURE);

    expect(events).toHaveLength(11);
    expect(events.map((e) => e.type)).toEqual([
      "system",
      "assistant",
      "assistant",
      "rate_limit_event",
      "user",
      "assistant",
      "user",
      "assistant",
      "assistant",
      "user",
      "result",
    ]);
  });

  it("keeps every complete line when the stream is cut off mid-event", () => {
    const truncated = FIXTURE.slice(0, -20);

    const events = parseStream(truncated);

    expect(events).toHaveLength(10);
    expect(events[events.length - 1].type).toBe("user");
    expect(lastResultEvent(events)).toBeUndefined();
  });

  it("passes an unknown event type through instead of failing on it", () => {
    const events = parseStream(
      ['{"type":"system"}', '{"type":"invented_in_a_later_cli","payload":1}', '{"type":"result"}'].join("\n")
    );

    expect(events.map((e) => e.type)).toEqual(["system", "invented_in_a_later_cli", "result"]);
  });

  it("skips noise the CLI prints outside the stream", () => {
    const events = parseStream(`A new version of Claude Code is available.\n{"type":"result"}\n`);

    expect(events.map((e) => e.type)).toEqual(["result"]);
  });

  it("skips JSON that is not an event", () => {
    const events = parseStream(['{"no":"type"}', "[1,2,3]", "null", '"a string"', '{"type":"result"}'].join("\n"));

    expect(events.map((e) => e.type)).toEqual(["result"]);
  });
});

describe("lastResultEvent", () => {
  it("picks the result event out of the real run", () => {
    const final = lastResultEvent(parseStream(FIXTURE)) as ResultEvent;

    expect(final.is_error).toBe(false);
    expect(final.subtype).toBe("success");
    expect(JSON.parse(final.result as string)).toMatchObject({ status: "completed", filesChanged: ["sample.ts"] });
  });

  it("takes the last one, not the first, when the stream carries more than one", () => {
    const events = parseStream(
      ['{"type":"result","num_turns":1}', '{"type":"assistant"}', '{"type":"result","num_turns":9}'].join("\n")
    );

    expect(lastResultEvent(events)?.num_turns).toBe(9);
  });

  it("returns undefined when the run produced no result event", () => {
    expect(lastResultEvent(parseStream('{"type":"system"}\n{"type":"assistant"}'))).toBeUndefined();
  });
});
