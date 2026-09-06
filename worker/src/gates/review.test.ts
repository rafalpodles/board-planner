import { describe, it, expect, vi, afterEach } from "vitest";
import { reviewGate } from "./review.js";
import { CommandResult, Runner } from "../exec.js";
import { ClaimedTask, DiffStats, GateContext } from "../types.js";
import { claimedTask } from "../__fixtures__/task.js";
import { scopedConfigListZ } from "../config-list.fixtures.js";

const TIMEOUT_MS = 5000;

const patch = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-export const a = 1;",
  "+export const a = 2;",
].join("\n");

function context(diff: Partial<DiffStats> = {}, task: Partial<ClaimedTask> = {}): GateContext {
  return {
    worktreePath: "/wt",
    task: claimedTask(task),
    result: {
      status: "completed",
      summary: "I did exactly what the task asked",
      filesChanged: ["a.ts"],
      testsAdded: ["a.test.ts"],
      blockedReason: "",
    },
    diff: { changedLines: 2, changedFiles: ["a.ts"], patch, truncated: false, headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c", symlinks: [], ...diff },
  };
}

function claudeStdout(stdout: string, overrides: Partial<CommandResult> = {}) {
  const run = vi.fn<Runner["run"]>(async (command) =>
    command === "git"
      ? { code: 0, stdout: "", stderr: "", timedOut: false }
      : { code: 0, stdout, stderr: "", timedOut: false, ...overrides }
  );
  return { runner: { run }, run };
}

function claudeCall(run: ReturnType<typeof claudeStdout>["run"]) {
  const call = run.mock.calls.find(([command]) => command === "claude");
  if (!call) throw new Error("the reviewer was never run");
  return call;
}

function gitCall(run: ReturnType<typeof claudeStdout>["run"], subcommand: string) {
  const call = run.mock.calls.find(([command, args]) => command === "git" && args.includes(subcommand));
  if (!call) throw new Error(`git ${subcommand} was never run`);
  return call;
}

function claudeReturning(verdict: unknown) {
  return claudeStdout(JSON.stringify({ result: JSON.stringify(verdict) }));
}

function promptOf(run: ReturnType<typeof claudeStdout>["run"]): string {
  return claudeCall(run)[1].join(" ");
}

describe("reviewGate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts an approving verdict", async () => {
    const { runner } = claudeReturning({ approved: true, reason: "looks right" });

    expect((await reviewGate(runner, TIMEOUT_MS).run(context())).ok).toBe(true);
  });

  it("rejects and carries the reviewer's reason", async () => {
    const { runner } = claudeReturning({ approved: false, reason: "drops the error branch" });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/drops the error branch/);
  });

  it("passes the diff and the task in the prompt", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context({}, { acceptanceCriteria: ["handles zero"] }));

    const prompt = promptOf(run);
    expect(prompt).toContain("diff --git a/a.ts");
    expect(prompt).toContain("CP-158");
    expect(prompt).toContain("handles zero");
  });

  it("labels the task and the diff as untrusted data rather than instructions", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(promptOf(run)).toMatch(/untrusted/i);
    expect(promptOf(run)).toMatch(/not instructions/i);
  });

  it("withholds the author's own summary so the reviewer is not primed by it", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(promptOf(run)).not.toContain("I did exactly what the task asked");
  });

  it.each([
    "CLAUDE.md",
    "worker/CLAUDE.md",
    "CLAUDE.local.md",
    "AGENTS.md",
    ".mcp.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/hooks/pre-commit.sh",
    "docs/.claude/agents/reviewer.md",
    "claude.md",
  ])("rejects a diff touching %s without spawning a reviewer", async (file) => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    const result = await reviewGate(runner, TIMEOUT_MS).run(
      context({ changedFiles: ["src/a.ts", file] })
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(file);
    expect(result.reason).toMatch(/human/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("still reviews a diff whose paths merely resemble the instruction files", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "fine" });

    const result = await reviewGate(runner, TIMEOUT_MS).run(
      context({ changedFiles: ["src/claude.ts", "docs/CLAUDE.md.template", "src/mcp.json"] })
    );

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalled();
  });

  it("gives the reviewer read-only tools and no permission bypass", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    const args = claudeCall(run)[1];
    expect(args[args.indexOf("--tools") + 1]).toBe("Read Grep Glob");
    expect(args).not.toContain("--allowedTools");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--permission-mode");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
  });

  it("reviews with the model policy.reviewModel names", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS, "sonnet").run(context());

    const args = claudeCall(run)[1];
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  });

  it("reviews with opus when reviewModel is blank rather than with no model at all", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS, "  ").run(context());

    const args = claudeCall(run)[1];
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args).not.toContain("");
  });

  it("asks for a schema-enforced verdict", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    const args = claudeCall(run)[1];
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args[args.indexOf("--json-schema") + 1]).toContain('"required":["approved","reason"]');
  });

  it("rejects a truncated diff without spawning a reviewer", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context({ truncated: true }));

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too large/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an empty patch without spawning a reviewer", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context({ patch: "   \n" }));

    expect(result.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("starts the reviewer with every discovered instruction channel disabled", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(claudeCall(run)[1]).toContain("--safe-mode");
  });

  it("still inherits HOME, so BP-349's surface is closed by --safe-mode and not by isolation", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(claudeCall(run)[2].env?.HOME).toBe(process.env.HOME);
  });

  it("refuses when the checkout could not be made, rather than reviewing nothing", async () => {
    const run = vi.fn<Runner["run"]>(async (command, args) =>
      command === "git" && args.includes("worktree") && args.includes("add")
        ? { code: 128, stdout: "", stderr: "fatal: invalid reference", timedOut: false }
        : { code: 0, stdout: "", stderr: "", timedOut: false }
    );

    const result = await reviewGate({ run }, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be checked out/i);
    expect(run.mock.calls.find(([command]) => command === "claude")).toBeUndefined();
  });

  it("hardens the checkout call itself, not only the calls that read", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    const [, addArgs] = gitCall(run, "worktree");
    expect(addArgs).toEqual(expect.arrayContaining(["-c", "core.hooksPath=/dev/null"]));
    expect(gitCall(run, "worktree")[2].env?.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  it("passes the signal to the checkout, not only to the reviewer", async () => {
    const controller = new AbortController();
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run({ ...context(), signal: controller.signal });

    expect(gitCall(run, "worktree")[2].signal).toBe(controller.signal);
  });

  it("reviews under the given budget", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(claudeCall(run)[2].timeoutMs).toBe(TIMEOUT_MS);
  });

  it("does not review in the worktree the agent wrote in", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(claudeCall(run)[2].cwd).not.toBe("/wt");
  });

  it("reviews in the checkout it made, of the commit the diff was taken from", async () => {
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    const [, addArgs] = gitCall(run, "worktree");
    expect(addArgs).toContain("--detach");
    expect(addArgs).toContain(context().diff.headSha);
    expect(claudeCall(run)[2].cwd).toBe(addArgs[addArgs.length - 2]);
  });

  it("refuses rather than checking out when the config carries something git would run", async () => {
    const run = vi.fn<Runner["run"]>(async (command, args) =>
      command === "git" && args.includes("--list")
        ? { code: 0, stdout: scopedConfigListZ("filter.z.smudge=/tmp/theirs.sh"), stderr: "", timedOut: false }
        : { code: 0, stdout: "", stderr: "", timedOut: false }
    );

    const result = await reviewGate({ run }, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/filter\.z\.smudge/);
    expect(run.mock.calls.find(([command, args]) => command === "git" && args.includes("worktree")))
      .toBeUndefined();
    expect(run.mock.calls.find(([command]) => command === "claude")).toBeUndefined();
  });

  it("removes the checkout afterwards, including when the reviewer rejected the change", async () => {
    const { runner, run } = claudeReturning({ approved: false, reason: "no" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    const [, removeArgs] = gitCall(run, "remove");
    const [, addArgs] = gitCall(run, "add");
    expect(removeArgs).toContain("--force");
    expect(removeArgs[removeArgs.length - 1]).toBe(addArgs[addArgs.length - 2]);
  });

  it("never passes an API key so the subscription is used", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(claudeCall(run)[2].env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claudeCall(run)[2].env?.PATH).toBe(process.env.PATH);
  });

  it("keeps the operator's own credentials out of the reviewer's environment", async () => {
    vi.stubEnv("CP_API_TOKEN", "cp_operator_credential");
    vi.stubEnv("GH_TOKEN", "gh_operator_credential");
    vi.stubEnv("HOME", "/Users/someone");
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run(context());

    const env = claudeCall(run)[2].env;
    expect(env?.CP_API_TOKEN).toBeUndefined();
    expect(env?.GH_TOKEN).toBeUndefined();
    expect(env?.HOME).toBe("/Users/someone");
  });

  it("passes the context's signal through to the runner, so a stop can kill the reviewer", async () => {
    const controller = new AbortController();
    const { runner, run } = claudeReturning({ approved: true, reason: "" });

    await reviewGate(runner, TIMEOUT_MS).run({ ...context(), signal: controller.signal });

    expect(claudeCall(run)[2].signal).toBe(controller.signal);
  });

  it("fails closed when the reviewer output cannot be parsed, keeping the raw output", async () => {
    const { runner } = claudeStdout("garbage");

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be completed/i);
    expect(result.reason).toMatch(/garbage/);
  });

  it.each([true, false])("caps a runaway reviewer reason (approved: %s)", async (approved) => {
    const { runner } = claudeReturning({ approved, reason: "x".repeat(5000) });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.reason.length).toBeLessThan(2200);
    expect(result.reason).toMatch(/truncated/i);
  });

  it("fails closed on a timeout and says the review never ran", async () => {
    const { runner } = claudeStdout("", { code: -1, timedOut: true });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be completed/i);
    expect(result.reason).toMatch(/timed out after 5000ms/);
  });

  it("fails closed on a non-zero exit and carries the error", async () => {
    const envelope = JSON.stringify({ result: '{"approved":true,"reason":"fine"}' });
    const { runner } = claudeStdout(envelope, {
      code: 1,
      stderr: "Claude usage limit reached",
    });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be completed/i);
    expect(result.reason).toMatch(/usage limit reached/);
  });

  it.each([
    ["approved as a string", { approved: "true", reason: "ship it" }],
    ['approved as the string "false"', { approved: "false", reason: "no" }],
    ["approved as a number", { approved: 1, reason: "ship it" }],
    ["a different field name", { verdict: "approve", reason: "ship it" }],
    ["a missing reason", { approved: true }],
    ["a non-string reason", { approved: true, reason: 5 }],
    ["a bare boolean", true],
    ["a null payload", null],
  ])("fails closed on a verdict with %s", async (_label, verdict) => {
    const { runner } = claudeReturning(verdict);

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be completed/i);
  });

  it("fails closed when the envelope carries no result", async () => {
    const { runner } = claudeStdout(JSON.stringify({ is_error: true, subtype: "error_max_turns" }));

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be completed/i);
  });

  it("accepts a verdict delivered as an object rather than a JSON string", async () => {
    const { runner } = claudeStdout(
      JSON.stringify({ result: { approved: true, reason: "matches the task" } })
    );

    expect((await reviewGate(runner, TIMEOUT_MS).run(context())).ok).toBe(true);
  });

  it("tolerates noise printed before the envelope", async () => {
    const { runner } = claudeStdout(
      `warning: config not found\n${JSON.stringify({ result: '{"approved":false,"reason":"missing a null check"}' })}`
    );

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing a null check/);
  });

  it("distinguishes a substantive rejection from a review that never ran", async () => {
    const { runner } = claudeReturning({ approved: false, reason: "drops the error branch" });

    const result = await reviewGate(runner, TIMEOUT_MS).run(context());

    expect(result.reason).not.toMatch(/could not be completed/i);
  });
});
