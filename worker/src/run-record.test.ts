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

  // The list the server accepts is asserted against its source in catalog-contract.test.ts — the
  // worker is a separate package, and importing the app's types here would drag its whole graph in
  it("maps every worker outcome onto one the server accepts", () => {
    const accepted = [
      "delivered",
      "merged",
      "refused",
      "blocked",
      "failed",
      "requeued",
      "released",
      "machineFault",
    ];
    // A Record, not an array: a new OutcomeKind is a type error here rather than an outcome this
    // loop silently never visits.
    const kinds = Object.keys({
      delivered: true,
      merged: true,
      gateRejected: true,
      blocked: true,
      failed: true,
      requeued: true,
      released: true,
      machineFault: true,
    } satisfies Record<OutcomeKind, true>) as OutcomeKind[];

    for (const kind of kinds) {
      expect(accepted).toContain(recordFor(task, kind, "", 0, 1, 0).outcome);
    }
  });

  // A machine fault is released on the board — attempt refunded, task back in the queue — and it
  // is only the recorded outcome that separates it from a usage limit or an operator's stop. Read
  // as `released`, the runs list cannot tell an operator which of their machines is broken.
  it("records a machine fault apart from a release", () => {
    expect(recordFor(task, "machineFault", "this machine has no sandbox", 0, 1, 0)).toMatchObject({
      outcome: "machineFault",
      refusedBy: "",
      detail: "this machine has no sandbox",
    });
    expect(recordFor(task, "released", "usage limit reached", 0, 1, 0).outcome).toBe("released");
  });

  // A failed fetch puts the whole of git's stderr in the detail, and this record is retried from
  // the outbox. The server cuts at the same number after reading the body, so the only thing this
  // changes is how many bytes cross the wire to be thrown away (found in review).
  it("cuts the detail where the server would, rather than sending it all to be cut there", () => {
    const record = recordFor(task, "machineFault", "x".repeat(5000), 0, 1, 0);

    expect(record.detail).toHaveLength(2000);
  });

  it("sends the times as instants the server can parse", () => {
    const record = recordFor(task, "merged", "", 1_700_000_000_000, 1_700_000_060_000, 0.25);

    expect(record.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(record.finishedAt).toBe(new Date(1_700_000_060_000).toISOString());
    expect(record.costUsd).toBe(0.25);
  });
});
