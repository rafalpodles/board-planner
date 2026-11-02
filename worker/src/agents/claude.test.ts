import { describe, it, expect } from "vitest";
import { NO_RUN } from "./agent.js";
import { CLAUDE_SIGNED_OUT, claudeAgent } from "./claude.js";

const agent = claudeAgent("/opt/bin/claude");
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

const EDIT = {
  prompt: "do it",
  systemPrompt: "rules",
  model: "opus",
  fallbackModel: "sonnet",
  resultSchema: { type: "object" },
  run: NO_RUN,
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
    const args = agent.reviewArgs({ prompt: "p", systemPrompt: "s", model: "opus", verdictSchema: {}, run: NO_RUN });

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

  describe("when the CLI has no login", () => {
    const SENTENCE = "Not logged in · Please run /login";
    const ended = (text: string, over: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        stop_reason: "stop_sequence",
        total_cost_usd: 0,
        result: text,
        ...over,
      });
    // Cut down from a real run of 2.1.314 with an empty HOME: --output-format stream-json, exit 1, stderr empty
    const STREAM = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        error: "authentication_failed",
        message: { model: "<synthetic>", content: [{ type: "text", text: SENTENCE }] },
      }),
      ended(SENTENCE),
    ].join("\n");

    it("reads it as the machine's fault, which refunds the attempt", () => {
      expect(agent.interpretEdit(run({ stdout: STREAM, code: 1 }))).toEqual({
        kind: "machine_fault",
        message: CLAUDE_SIGNED_OUT,
      });
    });

    it("says so of a review too, whose output is one result object", () => {
      expect(agent.sessionFault(run({ stdout: ended(SENTENCE), code: 1 }))).toBe(CLAUDE_SIGNED_OUT);
    });

    it.each([
      "Failed to authenticate: OAuth session expired and could not be refreshed",
      "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.",
      "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    ])("reads %s the same way", (sentence) => {
      expect(agent.sessionFault(run({ stdout: ended(sentence), code: 1 }))).toBe(CLAUDE_SIGNED_OUT);
    });

    it("does not take the agent's own words for it", () => {
      const written = JSON.stringify({ type: "result", result: SENTENCE });
      const exitedCleanly = run({ stdout: STREAM, code: 0 });

      expect(agent.interpretEdit(run({ stdout: written, code: 1 }))).toMatchObject({ kind: "error" });
      expect(agent.interpretEdit(exitedCleanly)).toMatchObject({ kind: "error" });
      expect(agent.sessionFault(exitedCleanly)).toBeNull();
    });

    it("leaves every other failed run alone", () => {
      expect(agent.sessionFault(run({ stdout: ended("API Error: 500"), code: 1 }))).toBeNull();
    });

    it.each([
      "Failed to authenticate. API Error: 403 Your organisation does not allow this",
      "Failed to refresh OAuth token: the network is down",
      "Failed to authenticate through the broker: no broker",
    ])("does not read %s as a lost login, which signing in again would not fix", (sentence) => {
      expect(agent.sessionFault(run({ stdout: ended(sentence), code: 1 }))).toBeNull();
    });

    it("does not take a refusal the model ended on the sentence for it", () => {
      const quoted = ended(`I will not do that. ${SENTENCE}`, { stop_reason: "refusal" });
      const continued = ended(`${SENTENCE} is what I would say`, { stop_reason: "refusal" });
      const paid = ended(SENTENCE, { stop_reason: "refusal", total_cost_usd: 0.42 });
      const notAnError = ended(SENTENCE, { is_error: false });

      for (const stdout of [quoted, continued, paid, notAnError]) {
        expect(agent.sessionFault(run({ stdout, code: 1 }))).toBeNull();
      }
    });
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

  it("says how the CLI ended a run it exited on with nothing on stderr, and none of its text", () => {
    const ended = JSON.stringify({ type: "result", subtype: "error_during_execution", stop_reason: "refusal", is_error: true, result: "model text" });

    expect(agent.interpretEdit(run({ code: 1, stdout: ended }))).toEqual({
      kind: "error",
      message: "the agent exited 1 (error_during_execution, refusal)",
    });
  });

  it("reads a verdict, and nothing else as one", () => {
    const verdict = JSON.stringify({ result: JSON.stringify({ approved: true, reason: "fine" }) });

    expect(agent.parseVerdict(verdict)).toEqual({ approved: true, reason: "fine" });
    expect(agent.parseVerdict("not json")).toBeNull();
    expect(agent.parseVerdict(JSON.stringify({ result: JSON.stringify({ approved: "yes" }) }))).toBeNull();
  });
});
