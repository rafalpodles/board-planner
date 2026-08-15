import { describe, it, expect } from "vitest";
import { recordFor } from "./run-record.js";
import { ClaimedTask } from "./types.js";
import { OutcomeKind } from "./telemetry.js";

const task = {
  taskId: "t1",
  taskKey: "CP-1",
  agent: { agentId: "a1", name: "Default", sequence: [] },
} as unknown as ClaimedTask;

describe("recordFor", () => {
  // An agent can be renamed or deleted; a record of what ran must not change when it is
  it("carries the agent by name as well as by id", () => {
    expect(recordFor(task, "delivered", "", 0, 1000, 0.5)).toMatchObject({
      agentId: "a1",
      agentName: "Default",
    });
  });

  // A report reads "refused by size-strict", so the key belongs in its own field rather than buried
  // in prose a query cannot group by
  it("names the block that refused, and leaves the detail empty", () => {
    expect(recordFor(task, "gateRejected", "size-strict", 0, 1000, 0)).toMatchObject({
      outcome: "refused",
      refusedBy: "size-strict",
      detail: "",
    });
  });

  it("keeps the detail for every other outcome, where nothing refused", () => {
    expect(recordFor(task, "blocked", "the scope is ambiguous", 0, 1000, 0)).toMatchObject({
      outcome: "blocked",
      refusedBy: "",
      detail: "the scope is ambiguous",
    });
  });

  // The server takes only what AGENT_RUN_OUTCOMES lists, and answers 400 to anything else
  it("maps every worker outcome onto one the server accepts", () => {
    const accepted = ["delivered", "merged", "refused", "blocked", "failed", "requeued", "released"];
    const kinds: OutcomeKind[] = [
      "delivered",
      "merged",
      "gateRejected",
      "blocked",
      "failed",
      "requeued",
      "released",
    ];

    for (const kind of kinds) {
      expect(accepted).toContain(recordFor(task, kind, "", 0, 1, 0).outcome);
    }
  });

  it("sends the times as instants the server can parse", () => {
    const record = recordFor(task, "merged", "", 1_700_000_000_000, 1_700_000_060_000, 0.25);

    expect(record.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(record.finishedAt).toBe(new Date(1_700_000_060_000).toISOString());
    expect(record.costUsd).toBe(0.25);
  });
});
