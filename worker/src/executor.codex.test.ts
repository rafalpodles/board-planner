import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexAgent } from "./agents/codex.js";
import { UNCONFINED_ESCAPE_HATCH } from "./env.js";
import { createExecutor } from "./executor.js";
import { CommandResult, Runner } from "./exec.js";
import { recordDir, SANDBOX_COMMAND } from "./sandbox.js";
import { claimedTask } from "./__fixtures__/task.js";
import { workerConfig } from "./__fixtures__/config.js";

/**
 * BP-987. A Codex step makes a home holding a copy of the operator's login before it spawns and must
 * remove it however the step ends: the common ends are the ones where nothing went well.
 */
const CODEX = "/opt/homebrew/bin/codex";
const scratch: string[] = [];
const made = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "bp987-exec-")));
  scratch.push(path);
  return path;
};

let worktree: string;
let tmp: string;
let sourceHome: string;

beforeEach(() => {
  vi.stubEnv(UNCONFINED_ESCAPE_HATCH, "");
  worktree = made();
  tmp = made();
  sourceHome = made();
  writeFileSync(join(sourceHome, "auth.json"), "{}");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

const leftovers = () => readdirSync(tmp).filter((name) => name.startsWith("cp-codex-"));

const OK = { status: "completed", summary: "s", filesChanged: [], testsAdded: [], blockedReason: "" };
const ok = (): CommandResult => ({
  code: 0,
  stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(OK) } })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
  stderr: "",
  timedOut: false,
});

function executeWith(run: Runner["run"], over: { worktreeDir?: ReturnType<typeof recordDir>; sourceHome?: string } = {}) {
  const executor = createExecutor(workerConfig(), { run }, codexAgent(CODEX, { sourceHome: over.sourceHome ?? sourceHome, tmp }));
  return executor.execute({
    task: claimedTask({}),
    worktreePath: worktree,
    worktreeDir: over.worktreeDir ?? recordDir(worktree),
    brief: { prompt: "do it", capability: "edit", model: "gpt-x", fallbackModel: "", timeoutMs: 1000 },
  });
}

describe("a codex step's run home", () => {
  it("is removed after a step that finished", async () => {
    const run = vi.fn<Runner["run"]>(async () => ok());

    expect(await executeWith(run)).toMatchObject({ kind: "result" });
    expect(leftovers()).toEqual([]);
  });

  it("is removed after a step that timed out", async () => {
    const run = vi.fn<Runner["run"]>(async () => ({ ...ok(), timedOut: true }));

    expect(await executeWith(run)).toEqual({ kind: "timeout" });
    expect(leftovers()).toEqual([]);
  });

  it("is removed after a machine fault", async () => {
    const run = vi.fn<Runner["run"]>(async () => ({ ...ok(), machineFault: "no space left" }));

    expect(await executeWith(run)).toEqual({ kind: "machine_fault", message: "no space left" });
    expect(leftovers()).toEqual([]);
  });

  it("is removed when the runner throws, and the throw is not swallowed", async () => {
    const run = vi.fn<Runner["run"]>(async () => {
      throw new Error("spawn exploded");
    });

    await expect(executeWith(run)).rejects.toThrow("spawn exploded");
    expect(leftovers()).toEqual([]);
  });

  it("is removed when the step cannot be confined, which spawns nothing", async () => {
    const dir = recordDir(worktree);
    rmSync(worktree, { recursive: true });
    const run = vi.fn<Runner["run"]>(async () => ok());

    expect(await executeWith(run, { worktreeDir: dir })).toMatchObject({ kind: "tampered" });
    expect(run).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });
});

describe("a codex step on a machine that is not signed in", () => {
  it("is a machine fault that spawns nothing and makes no home, rather than an error that spends the attempt", async () => {
    const run = vi.fn<Runner["run"]>(async () => ok());

    expect(await executeWith(run, { sourceHome: made() })).toEqual({
      kind: "machine_fault",
      message: expect.stringMatching(/not signed in.*codex login/),
    });
    expect(run).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });
});

describe("what a codex step is spawned with", () => {
  it("names the schema in its own home, and that home is the one it may write and is told of", async () => {
    const run = vi.fn<Runner["run"]>(async () => ok());
    await executeWith(run);

    const [command, args, options] = run.mock.calls[0];
    expect(command).toBe(SANDBOX_COMMAND);
    const home = options?.env?.CODEX_HOME;
    expect(home).toMatch(/cp-codex-/);
    expect(args[args.indexOf("--output-schema") + 1]).toBe(join(home!, "schema.json"));
    expect(args).toContain(`W1=${home}`);
    expect(args).toContain(`W0=${worktree}`);
  });
});
