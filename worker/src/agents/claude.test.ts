import { describe, it, expect } from "vitest";
import { claudeAgent } from "./claude.js";

const agent = claudeAgent("/opt/bin/claude");
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

const EDIT = {
  prompt: "do it",
  systemPrompt: "rules",
  model: "opus",
  fallbackModel: "sonnet",
  resultSchema: { type: "object" },
};

describe("the claude adapter's argv", () => {
  it("gives an editing step the edit tools and no shell, under bypassPermissions", () => {
    const args = agent.editArgs({ ...EDIT, capability: "edit" });

    expect(value(args, "--tools")).toBe("Read Edit Write Grep Glob");
    expect(value(args, "--permission-mode")).toBe("bypassPermissions");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--allowedTools");
  });

  it("gives a read-only step no tool that writes", () => {
    const args = agent.editArgs({ ...EDIT, capability: "read-only" });

    expect(value(args, "--tools")).toBe("Read Grep Glob");
  });

  it("passes the prompt, the system prompt, both models and the schema", () => {
    const args = agent.editArgs({ ...EDIT, capability: "edit" });

    expect(value(args, "-p")).toBe("do it");
    expect(value(args, "--append-system-prompt")).toBe("rules");
    expect(value(args, "--model")).toBe("opus");
    expect(value(args, "--fallback-model")).toBe("sonnet");
    expect(JSON.parse(value(args, "--json-schema"))).toEqual({ type: "object" });
  });

  it("gives the reviewer read tools only, the operator's servers dropped and every instruction channel closed", () => {
    const args = agent.reviewArgs({ prompt: "p", systemPrompt: "s", model: "opus", verdictSchema: {} });

    expect(value(args, "--tools")).toBe("Read Grep Glob");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--safe-mode");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--allowedTools");
  });
});

describe("the claude adapter reading a finished step", () => {
  const run = (over: Partial<{ stdout: string; stderr: string; code: number }>) => ({
    stdout: "",
    stderr: "",
    code: 0,
    timedOut: false,
    ...over,
  });
  const result = (payload: unknown) => JSON.stringify({ type: "result", result: JSON.stringify(payload) }) + "\n";
  const OK = { status: "completed", summary: "s", filesChanged: ["a"], testsAdded: [], blockedReason: "" };

  it("reads a schema-valid result", () => {
    expect(agent.interpretEdit(run({ stdout: result(OK) }))).toEqual({ kind: "result", result: OK });
  });

  it("reads a rejected rate limit as a usage limit", () => {
    const stdout = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }) + "\n";

    expect(agent.interpretEdit(run({ stdout, code: 1 }))).toEqual({ kind: "usage_limit" });
  });

  it("takes the CLI's own sentinel as a usage limit and a sentence the agent wrote as nothing of the kind", () => {
    const sentinel = JSON.stringify({ type: "result", result: "Claude usage limit reached|1760000000" }) + "\n";
    const written = JSON.stringify({ type: "result", result: "I fixed the usage limit reached check" }) + "\n";

    expect(agent.interpretEdit(run({ stdout: sentinel, code: 1 }))).toEqual({ kind: "usage_limit" });
    expect(agent.interpretEdit(run({ stdout: written, code: 1 }))).toMatchObject({ kind: "error" });
  });

  it("says the agent exited, with its stderr, when it died without a result", () => {
    expect(agent.interpretEdit(run({ code: 2, stderr: "sandbox-exec: nope" }))).toEqual({
      kind: "error",
      message: "the agent exited 2\nsandbox-exec: nope",
    });
  });

  it("reads a verdict, and nothing else as one", () => {
    const verdict = JSON.stringify({ result: JSON.stringify({ approved: true, reason: "fine" }) });

    expect(agent.parseVerdict(verdict)).toEqual({ approved: true, reason: "fine" });
    expect(agent.parseVerdict("not json")).toBeNull();
    expect(agent.parseVerdict(JSON.stringify({ result: JSON.stringify({ approved: "yes" }) }))).toBeNull();
  });
});
