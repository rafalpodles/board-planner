import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarise } from "../telemetry.js";
import { AgentRun, NO_RUN } from "./agent.js";
import { RESULT_SCHEMA } from "../executor.js";
import { codexAgent, strictSchema } from "./codex.js";

const scratch: string[] = [];
function dir(): string {
  const path = mkdtempSync(join(tmpdir(), "bp987-codex-"));
  scratch.push(path);
  return path;
}
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

const RUN: AgentRun = { env: {}, writable: [], dir: "/run/home", cleanup: async () => {} };
const agent = codexAgent("/opt/homebrew/bin/codex");
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const EDIT = {
  prompt: "the task",
  systemPrompt: "the rules",
  capability: "edit" as const,
  model: "gpt-x",
  fallbackModel: "",
  resultSchema: { type: "object" },
  run: RUN,
};
const REVIEW = { prompt: "the diff", systemPrompt: "judge it", model: "gpt-x", verdictSchema: {}, run: RUN };

describe("the codex adapter's argv", () => {
  it("runs exec under our own sandbox, never Codex's, with its own login home and no user config", () => {
    const args = agent.editArgs(EDIT);

    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("-s");
  });

  it("switches off web search and every capability beyond a shell and the patch tool", () => {
    const args = agent.editArgs(EDIT);
    const disabled = args.flatMap((arg, i) => (arg === "--disable" ? [args[i + 1]] : []));

    expect(args).toContain('web_search="disabled"');
    expect(disabled).toEqual(
      expect.arrayContaining(["browser_use", "computer_use", "hooks", "plugins", "multi_agent", "apps", "image_generation", "memories"]),
    );
  });

  it("names the model and the schema file in the run's own home", () => {
    const args = agent.editArgs(EDIT);

    expect(value(args, "-m")).toBe("gpt-x");
    expect(value(args, "--output-schema")).toBe("/run/home/schema.json");
  });

  it("puts the rules before the task in the one prompt, after a -- so it can never read as a flag", () => {
    const args = agent.editArgs({ ...EDIT, prompt: "--dangerously-do-something" });

    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("the rules\n\n---\n\n--dangerously-do-something");
  });

  it("tells the reviewer to load no instructions from the checkout, and the implementer nothing of the kind", () => {
    expect(agent.reviewArgs(REVIEW)).toEqual(expect.arrayContaining(["-c", "project_doc_max_bytes=0"]));
    expect(agent.editArgs(EDIT)).not.toContain("project_doc_max_bytes=0");
  });
});

describe("the codex adapter's confinement", () => {
  it("lets only an editing step write in the worktree, and the reviewer never in its checkout", () => {
    expect(agent.worktreeWritable("edit")).toBe(true);
    expect(agent.worktreeWritable("read-only")).toBe(false);
    expect(agent.reviewerWritesCheckout).toBe(false);
  });

  it("is the opposite of claude's, whose read-only steps keep the worktree writable behind a tool list", async () => {
    const { claudeAgent } = await import("./claude.js");

    expect(claudeAgent("/x").worktreeWritable("read-only")).toBe(true);
  });
});

describe("the codex adapter's run home", () => {
  function operatorHome(): string {
    const home = dir();
    writeFileSync(join(home, "auth.json"), '{"tokens":"secret"}');
    writeFileSync(join(home, "config.toml"), '[mcp_servers.board]\ncommand = "x"\n');
    return home;
  }

  it("holds a copy of the login and the schema, and nothing else of the operator's home", async () => {
    const tmp = dir();
    const run = (await codexAgent("/x", { sourceHome: operatorHome(), tmp }).prepare({ type: "object" })) as AgentRun;

    expect(readdirSync(run.dir!).sort()).toEqual(["auth.json", "schema.json"]);
    expect(readFileSync(join(run.dir!, "auth.json"), "utf8")).toBe('{"tokens":"secret"}');
    expect(JSON.parse(readFileSync(join(run.dir!, "schema.json"), "utf8"))).toEqual({ type: "object" });
    expect(run.env).toEqual({ CODEX_HOME: run.dir });
    expect(run.writable).toEqual([run.dir]);
  });

  it("writes the schema the way OpenAI's strict mode insists on, every object closed and fully required", async () => {
    const run = (await codexAgent("/x", { sourceHome: operatorHome(), tmp: dir() }).prepare(RESULT_SCHEMA)) as AgentRun;
    const written = JSON.parse(readFileSync(join(run.dir!, "schema.json"), "utf8"));

    expect(written.additionalProperties).toBe(false);
    expect(written.required).toEqual(Object.keys(RESULT_SCHEMA.properties));
    expect(written.properties.filesChanged.items).toEqual({ type: "string" });
  });

  it("keeps the copy to its owner", async () => {
    const run = (await codexAgent("/x", { sourceHome: operatorHome(), tmp: dir() }).prepare({})) as AgentRun;

    expect(statSync(run.dir!).mode & 0o777).toBe(0o700);
    expect(statSync(join(run.dir!, "auth.json")).mode & 0o777).toBe(0o600);
  });

  it("removes the home, the login copy included, when the run is over", async () => {
    const run = (await codexAgent("/x", { sourceHome: operatorHome(), tmp: dir() }).prepare({})) as AgentRun;

    await run.cleanup();

    expect(existsSync(run.dir!)).toBe(false);
  });

  it("says the machine is not signed in, rather than starting a run that cannot work", async () => {
    const made = await codexAgent("/x", { sourceHome: dir(), tmp: dir() }).prepare({});

    expect(made).toEqual({ refusal: expect.stringMatching(/not signed in.*codex login/) });
  });

  it("makes a home of its own for every run", async () => {
    const tmp = dir();
    const a = codexAgent("/x", { sourceHome: operatorHome(), tmp });
    const one = (await a.prepare({})) as AgentRun;
    const two = (await a.prepare({})) as AgentRun;

    expect(one.dir).not.toBe(two.dir);
  });

  it("is what claude does not need: no home, no environment", async () => {
    const { claudeAgent } = await import("./claude.js");

    expect(await claudeAgent("/x").prepare({})).toBe(NO_RUN);
  });
});

const line = (event: unknown) => `${JSON.stringify(event)}\n`;
const message = (text: string) => line({ type: "item.completed", item: { id: "i", type: "agent_message", text } });
const done = line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
const OK = { status: "completed", summary: "s", filesChanged: ["a.ts"], testsAdded: [], blockedReason: "" };
const run = (over: Partial<{ stdout: string; stderr: string; code: number }>) => ({ stdout: "", stderr: "", code: 0, timedOut: false, ...over });

describe("the codex adapter reading a finished step", () => {
  it("reads the final message of a completed turn as the result", () => {
    const stdout = line({ type: "thread.started" }) + message("working on it") + message(JSON.stringify(OK)) + done;

    expect(agent.interpretEdit(run({ stdout }))).toEqual({ kind: "result", result: OK });
  });

  it("does not take a result from a turn that never completed", () => {
    const stdout = message(JSON.stringify(OK));

    expect(agent.interpretEdit(run({ stdout, code: 1 }))).toMatchObject({ kind: "error" });
  });

  it("says the schema was not met, and when the message is not JSON at all", () => {
    expect(agent.interpretEdit(run({ stdout: message('{"status":"completed"}') + done }))).toEqual({
      kind: "error",
      message: "codex output did not match the result schema",
    });
    expect(agent.interpretEdit(run({ stdout: message("done!") + done }))).toEqual({
      kind: "error",
      message: "could not parse codex output",
    });
  });

  it("reports a failed turn with what Codex said, bounded", () => {
    const stdout = line({ type: "turn.failed", error: { message: "x".repeat(2000) } });
    const outcome = agent.interpretEdit(run({ stdout, code: 1 }));

    expect(outcome).toMatchObject({ kind: "error", message: expect.stringMatching(/^codex reported: x+$/) });
    expect((outcome as { message: string }).message.length).toBeLessThan(600);
  });

  // Not measured (it needs a real limit), so not guessed: whatever Codex says, it is an error that
  // spends the attempt until somebody has seen the wording
  it("has no usage limit to recognise yet", () => {
    const stdout = line({ type: "turn.failed", error: { message: "You've hit your usage limit" } });

    expect(agent.interpretEdit(run({ stdout, code: 1 }))).toMatchObject({ kind: "error" });
  });

  it("says the agent exited, with its stderr, when it died with no events", () => {
    expect(agent.interpretEdit(run({ code: 2, stderr: "sandbox-exec: nope" }))).toEqual({
      kind: "error",
      message: "the agent exited 2\nsandbox-exec: nope",
    });
  });

  it("reads a verdict from a completed turn, and nothing else as one", () => {
    const verdict = message(JSON.stringify({ approved: false, reason: "no" })) + done;

    expect(agent.parseVerdict(verdict)).toEqual({ approved: false, reason: "no" });
    expect(agent.parseVerdict(message(JSON.stringify({ approved: true, reason: "ok" })))).toBeNull();
    expect(agent.parseVerdict(message("approved") + done)).toBeNull();
    expect(agent.parseVerdict(message(JSON.stringify({ approved: "yes" })) + done)).toBeNull();
  });
});

describe("the codex adapter's live events", () => {
  const update = (text: string) => agent.parseEvents(text).map((event) => summarise(event));

  it("shows a command as a tool in use, naming the program and not Codex's shell wrapper", () => {
    const started = line({ type: "item.started", item: { type: "command_execution", command: "/bin/zsh -lc 'npm test -- --run'", status: "in_progress" } });

    expect(update(started)).toEqual([{ phase: "agent", tool: { name: "Bash", target: "npm" } }]);
  });

  it("shows a turn's end as the agent's result", () => {
    expect(update(done)).toEqual([{ phase: "agent", turns: undefined, costUsd: undefined }]);
  });

  it("shows nothing for what the model says, which can be anything", () => {
    expect(agent.parseEvents(message("rm -rf /") + line({ type: "item.started", item: { type: "agent_message" } }))).toEqual([]);
  });
});

describe("strictSchema", () => {
  it("closes an object nested anywhere, and lists its properties as required", () => {
    const out = strictSchema({
      type: "object",
      properties: { a: { type: "array", items: { type: "object", properties: { b: { type: "string" } } } } },
    }) as { additionalProperties: boolean; required: string[]; properties: { a: { items: { additionalProperties: boolean; required: string[] } } } };

    expect(out.additionalProperties).toBe(false);
    expect(out.required).toEqual(["a"]);
    expect(out.properties.a.items).toMatchObject({ additionalProperties: false, required: ["b"] });
  });

  it("leaves what is not an object alone, and does not change its input", () => {
    const input = { type: "object", properties: { n: { type: "number" } } };
    strictSchema(input);

    expect(input).toEqual({ type: "object", properties: { n: { type: "number" } } });
    expect(strictSchema({ type: "string", enum: ["a"] })).toEqual({ type: "string", enum: ["a"] });
  });
});
