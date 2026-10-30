import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNCONFINED_REASON } from "../sandbox.js";
import { reviewGate } from "./review.js";
import { codexAgent } from "../agents/codex.js";
import { Runner } from "../exec.js";
import { SANDBOX_COMMAND } from "../sandbox.js";
import { claimedTask } from "../__fixtures__/task.js";
import { GateContext } from "../types.js";

/**
 * BP-987. The review gate on a coding agent that has a shell and no tool list to leave the write
 * tools out of: the reviewer is read-only by confinement, so what it may write is asserted on the
 * spawn as the runner saw it.
 */
const gitPath = "/opt/homebrew/bin/git";
const CODEX = "/opt/homebrew/bin/codex";
const scratch: string[] = [];
const made = () => {
  const path = mkdtempSync(join(tmpdir(), "bp987-rev-"));
  scratch.push(path);
  return path;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

const context: GateContext = {
  worktreePath: "/wt",
  worktreeDir: { path: "/wt", dev: 0, ino: 0 },
  gateHome: { path: "/wt.home", dev: 0, ino: 1 },
  task: claimedTask({}),
  result: { status: "completed", summary: "did it", filesChanged: ["a.ts"], testsAdded: [], blockedReason: "" },
  diff: {
    changedLines: 2,
    changedFiles: ["a.ts"],
    patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    truncated: false,
    headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
    symlinks: [],
    suppressedDiffs: [],
    gitlinks: [],
  },
};

const jsonl = (verdict: unknown) =>
  `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(verdict) } })}\n${JSON.stringify({ type: "turn.completed" })}\n`;

const homes = new Map<string, string>();
const sourceOf = (tmp: string) => homes.get(tmp)!;

function setup(verdict: unknown) {
  const home = made();
  writeFileSync(join(home, "auth.json"), "{}");
  const tmp = made();
  homes.set(tmp, home);
  const run = vi.fn<Runner["run"]>(async (command) =>
    command === gitPath ? { code: 0, stdout: "", stderr: "", timedOut: false } : { code: 0, stdout: jsonl(verdict), stderr: "", timedOut: false },
  );
  const gate = reviewGate({ run }, gitPath, codexAgent(CODEX, { sourceHome: home, tmp }), 5000, "gpt-x");
  return { run, gate, tmp };
}

const spawnOf = (run: ReturnType<typeof setup>["run"]) => {
  const call = run.mock.calls.find(([command]) => command === SANDBOX_COMMAND);
  if (!call) throw new Error("the reviewer was never run");
  return call;
};

const writableOf = (args: readonly string[]) =>
  args.flatMap((arg, i) => (args[i - 1] === "-D" && /^W\d+=/.test(arg) ? [arg.replace(/^W\d+=/, "")] : []));

describe("the review gate on codex", () => {
  it("reads the verdict from the final message of the turn", async () => {
    const { gate } = setup({ approved: true, reason: "fine" });

    expect(await gate.run(context)).toEqual({ ok: true, reason: "fine" });
  });

  it("rejects with the reviewer's reason", async () => {
    const { gate } = setup({ approved: false, reason: "drops an error path" });

    expect(await gate.run(context)).toEqual({ ok: false, reason: "the reviewer rejected the change: drops an error path" });
  });

  it("lets the reviewer write only in its own home, never in the checkout it is judging", async () => {
    const { gate, run } = setup({ approved: true, reason: "ok" });
    await gate.run(context);

    const [, args] = spawnOf(run);
    const writable = writableOf(args);
    expect(writable).toHaveLength(1);
    expect(writable[0]).toMatch(/cp-codex-/);
    expect(writable.some((path) => path.includes("cp-review-"))).toBe(false);
  });

  it("hands the run its own home and asks it to load no instructions from the checkout", async () => {
    const { gate, run } = setup({ approved: true, reason: "ok" });
    await gate.run(context);

    const [, args, options] = spawnOf(run);
    const [home] = writableOf(args);
    expect(options?.env?.CODEX_HOME).toBe(home);
    expect(args).toContain("project_doc_max_bytes=0");
  });

  it("removes the reviewer's home, and the login copied into it, when the gate is over", async () => {
    const { gate, run, tmp } = setup({ approved: true, reason: "ok" });
    await gate.run(context);

    const [home] = writableOf(spawnOf(run)[1]);
    expect(existsSync(home)).toBe(false);
    expect(readdirSync(tmp).filter((name) => name.startsWith("cp-codex-"))).toEqual([]);
  });

  it("is a machine fault, not a rejection, when the machine is not signed in", async () => {
    const run = vi.fn<Runner["run"]>(async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }));
    const gate = reviewGate({ run }, gitPath, codexAgent(CODEX, { sourceHome: made(), tmp: made() }), 5000, "gpt-x");

    expect(await gate.run(context)).toMatchObject({ ok: false, machineFault: true, reason: expect.stringMatching(/not signed in/) });
  });

  it("names the schema in the reviewer's own home", async () => {
    const { gate, run } = setup({ approved: true, reason: "ok" });
    await gate.run(context);

    const [, args, options] = spawnOf(run);
    expect(args[args.indexOf("--output-schema") + 1]).toBe(join(options!.env!.CODEX_HOME!, "schema.json"));
  });

  it("hands the reviewer the rules, before the task and after a --", async () => {
    const { gate, run } = setup({ approved: true, reason: "ok" });
    await gate.run(context);

    const [, args] = spawnOf(run);
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toMatch(/^You are reviewing a diff produced by another agent[\s\S]*\n\n---\n\n/);
  });

  describe("the reviewer's home and the clean checkout, whatever happens to the review", () => {
    const checkoutOf = (run: ReturnType<typeof setup>["run"]) => spawnOf(run)[2]!.cwd as string;

    it("go when the reviewer times out", async () => {
      const { run, tmp } = setup({ approved: true, reason: "ok" });
      run.mockImplementation(async (command) => ({ code: command === gitPath ? 0 : 1, stdout: "", stderr: "", timedOut: command !== gitPath }));
      const gate = reviewGate({ run }, gitPath, codexAgent(CODEX, { sourceHome: sourceOf(tmp), tmp }), 5000, "gpt-x");

      expect(await gate.run(context)).toMatchObject({ ok: false, reason: expect.stringMatching(/timed out/) });
      expect(readdirSync(tmp).filter((name) => name.startsWith("cp-codex-"))).toEqual([]);
      expect(existsSync(checkoutOf(run))).toBe(false);
    });

    it("go when the runner throws, and the throw is not swallowed", async () => {
      const { run, tmp } = setup({ approved: true, reason: "ok" });
      run.mockImplementation(async (command) => {
        if (command === gitPath) return { code: 0, stdout: "", stderr: "", timedOut: false };
        throw new Error("spawn exploded");
      });
      const gate = reviewGate({ run }, gitPath, codexAgent(CODEX, { sourceHome: sourceOf(tmp), tmp }), 5000, "gpt-x");

      await expect(gate.run(context)).rejects.toThrow("spawn exploded");
      expect(readdirSync(tmp).filter((name) => name.startsWith("cp-codex-"))).toEqual([]);
      const checkouts = run.mock.calls.filter(([command]) => command === gitPath).map(([, args]) => String(args[args.indexOf("--detach") + 2]));
      expect(checkouts.filter((path) => path && existsSync(path))).toEqual([]);
    });

    it("go even when the run's own cleanup throws", async () => {
      const { run, tmp } = setup({ approved: true, reason: "ok" });
      const base = codexAgent(CODEX, { sourceHome: sourceOf(tmp), tmp });
      const agent = {
        ...base,
        prepare: async (schema: object) => {
          const prepared = await base.prepare(schema);
          if ("refusal" in prepared) return prepared;
          return { ...prepared, cleanup: async () => { await prepared.cleanup(); throw new Error("cleanup failed"); } };
        },
      };
      const gate = reviewGate({ run }, gitPath, agent, 5000, "gpt-x");

      await expect(gate.run(context)).rejects.toThrow("cleanup failed");
      expect(existsSync(checkoutOf(run))).toBe(false);
    });

    it("go when the machine cannot confine the reviewer, which spawns nothing", async () => {
      const { run, tmp } = setup({ approved: true, reason: "ok" });
      const gate = reviewGate({ run }, gitPath, codexAgent(CODEX, { sourceHome: sourceOf(tmp), tmp }), 5000, "gpt-x");
      const real = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      try {
        expect(await gate.run(context)).toEqual({ ok: false, reason: UNCONFINED_REASON, machineFault: true });
      } finally {
        Object.defineProperty(process, "platform", real);
      }
      expect(run.mock.calls.some(([command]) => command === SANDBOX_COMMAND)).toBe(false);
      expect(readdirSync(tmp).filter((name) => name.startsWith("cp-codex-"))).toEqual([]);
    });
  });
});
