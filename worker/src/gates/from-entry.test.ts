import { describe, it, expect, vi } from "vitest";
import { gateFromEntry } from "./from-entry.js";
import { GateContext, SnapshotEntry } from "../types.js";

function entry(over: Partial<SnapshotEntry>): SnapshotEntry {
  return {
    key: "diff-size",
    kind: "gate",
    name: "Size",
    gateKind: "diff-size",
    params: {},
    ...over,
  };
}

function ctx(changedLines: number): GateContext {
  return {
    worktreePath: "/wt",
    task: { taskKey: "CP-1", title: "t", description: "", acceptanceCriteria: [] } as never,
    result: {} as never,
    diff: {
      changedLines,
      changedFiles: ["src/a.ts"],
      patch: "diff --git a/src/a.ts b/src/a.ts\n+one",
      truncated: false,
    },
  };
}

const idleRunner = { run: vi.fn() } as never;

describe("gateFromEntry", () => {
  // Two Size gates in one agent have to be distinguishable in the comment that refuses
  it("names the gate after the block, not after the kind", () => {
    expect(gateFromEntry(entry({ key: "size-strict" }), idleRunner, 1000, "opus")?.name).toBe(
      "size-strict"
    );
  });

  it("takes the threshold from the entry rather than from the worker's config", async () => {
    const gate = gateFromEntry(entry({ params: { maxLines: "10" } }), idleRunner, 1000, "opus");
    const verdict = await gate!.run(ctx(50));

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/10/);
  });

  // A threshold of zero refuses every change, which reads as a broken gate rather than a strict one
  it("falls back to the built-in default when a parameter is not a positive number", async () => {
    for (const maxLines of ["lots", "0", "-5", ""]) {
      const gate = gateFromEntry(entry({ params: { maxLines } }), idleRunner, 1000, "opus");
      expect((await gate!.run(ctx(5))).ok).toBe(true);
    }
  });

  it("returns null for a kind this worker does not implement", () => {
    expect(gateFromEntry(entry({ gateKind: "invented" }), idleRunner, 1000, "opus")).toBeNull();
  });

  it("passes the entry's model and focus down to a review gate", async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ result: { approved: true, reason: "fine" } }),
      stderr: "",
      timedOut: false,
    }));
    const gate = gateFromEntry(
      entry({
        key: "security-review",
        name: "Security reviewed",
        gateKind: "review",
        params: { model: "sonnet", focus: "security" },
      }),
      { run } as never,
      1000,
      "opus"
    );

    expect(gate?.name).toBe("security-review");
    await gate!.run(ctx(5));

    const argv = run.mock.calls[0][1] as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toMatch(/injection/i);
  });

  it("falls back to the worker's review model when the entry names none", async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ result: { approved: true, reason: "fine" } }),
      stderr: "",
      timedOut: false,
    }));
    const gate = gateFromEntry(
      entry({ key: "review", gateKind: "review", params: {} }),
      { run } as never,
      1000,
      "sonnet"
    );
    await gate!.run(ctx(5));

    const argv = run.mock.calls[0][1] as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).not.toMatch(/injection/i);
  });

  it("builds every kind the catalog offers", () => {
    for (const gateKind of ["diff-size", "protected-paths", "test-presence", "build", "test-run", "review"]) {
      expect(gateFromEntry(entry({ gateKind }), idleRunner, 1000, "opus")).not.toBeNull();
    }
  });
});
