import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarise } from "../telemetry.js";
import { AgentRun, NO_RUN } from "./agent.js";
import { RESULT_SCHEMA } from "../executor.js";
import { codexAgent, removeRunHome, strictSchema, sweepRunHomes } from "./codex.js";

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
    expect([...disabled].sort()).toEqual(
      [
        "apps", "browser_use", "computer_use", "hooks", "image_generation", "in_app_browser", "memories",
        "multi_agent", "plugin_sharing", "plugins", "remote_plugin", "skill_search", "sleep_tool", "tool_suggest",
      ].sort(),
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

  it("gives the reviewer the rules before the diff, after a --, and the same run home", () => {
    const args = agent.reviewArgs(REVIEW);

    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("judge it\n\n---\n\nthe diff");
    expect(value(args, "--output-schema")).toBe("/run/home/schema.json");
    expect(value(args, "-m")).toBe("gpt-x");
  });

  it("refuses to build an argv for a run that was never prepared", () => {
    expect(() => agent.editArgs({ ...EDIT, run: NO_RUN })).toThrow(/prepare/);
    expect(() => agent.reviewArgs({ ...REVIEW, run: NO_RUN })).toThrow(/prepare/);
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

  it("keeps the schema to its owner too", async () => {
    const run = (await codexAgent("/x", { sourceHome: operatorHome(), tmp: dir() }).prepare({})) as AgentRun;

    expect(statSync(join(run.dir!, "schema.json")).mode & 0o777).toBe(0o600);
  });

  it("leaves no half-made home behind when the copy fails", async () => {
    const source = dir();
    mkdirSync(join(source, "auth.json"));
    const tmp = dir();

    const made = await codexAgent("/x", { sourceHome: source, tmp }).prepare({});

    expect(made).toEqual({ refusal: expect.stringMatching(/could not make a home/) });
    expect(readdirSync(tmp)).toEqual([]);
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

describe("removing a run's home", () => {
  it("removes a home the run made unreadable, nested directories and the login copy included", () => {
    const home = dir();
    mkdirSync(join(home, "sub", "deeper"), { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}");
    writeFileSync(join(home, "sub", "deeper", "x"), "x");
    chmodSync(join(home, "sub", "deeper"), 0o000);
    chmodSync(join(home, "sub"), 0o000);
    chmodSync(home, 0o000);

    removeRunHome(home);

    expect(existsSync(home)).toBe(false);
  });

  it("does not follow a link out of the home, to make it writable or to delete it", () => {
    const home = dir();
    const elsewhere = dir();
    writeFileSync(join(elsewhere, "keep"), "k");
    chmodSync(join(elsewhere, "keep"), 0o444);
    symlinkSync(elsewhere, join(home, "link"));
    chmodSync(home, 0o000);

    removeRunHome(home);

    expect(existsSync(home)).toBe(false);
    expect(readFileSync(join(elsewhere, "keep"), "utf8")).toBe("k");
    expect(statSync(join(elsewhere, "keep")).mode & 0o777).toBe(0o444);
  });

  it("says nothing, and throws nothing, for a home that is already gone", () => {
    const logged: string[] = [];

    expect(() => removeRunHome(join(dir(), "never-made"), (m) => logged.push(m))).not.toThrow();
    expect(logged).toEqual([]);
  });
});

describe("sweeping the homes a killed worker left", () => {
  // A pid that certainly belongs to nobody: a child that has exited
  const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
  const home = (tmp: string, name: string) => {
    mkdirSync(join(tmp, name));
    writeFileSync(join(tmp, name, "auth.json"), "{}");
  };

  it("removes the homes of a process that is gone, and leaves a live one's and anything else in the directory", () => {
    const tmp = dir();
    const dead = deadPid();
    home(tmp, `cp-codex-${dead}-aaaa`);
    home(tmp, `cp-codex-${process.pid}-bbbb`);
    home(tmp, "cp-codex-nopid");
    home(tmp, `cp-review-${dead}-cccc`);
    home(tmp, "other");

    sweepRunHomes(tmp);

    expect(readdirSync(tmp).sort()).toEqual([`cp-codex-${process.pid}-bbbb`, "cp-codex-nopid", `cp-review-${dead}-cccc`, "other"].sort());
  });

  it("does not look at how old a home is: a long run's home is as live as its worker", () => {
    const tmp = dir();
    home(tmp, `cp-codex-${process.pid}-old`);
    const longAgo = new Date(Date.now() - 48 * 3_600_000);
    utimesSync(join(tmp, `cp-codex-${process.pid}-old`), longAgo, longAgo);

    sweepRunHomes(tmp);

    expect(readdirSync(tmp)).toEqual([`cp-codex-${process.pid}-old`]);
  });

  it("does not follow a link named like a home", () => {
    const tmp = dir();
    const elsewhere = dir();
    writeFileSync(join(elsewhere, "keep"), "k");
    symlinkSync(elsewhere, join(tmp, `cp-codex-${deadPid()}-link`));

    sweepRunHomes(tmp);

    expect(readFileSync(join(elsewhere, "keep"), "utf8")).toBe("k");
  });

  it("names the pid of the worker that made a home", async () => {
    const run = (await codexAgent("/x", { sourceHome: (() => { const h = dir(); writeFileSync(join(h, "auth.json"), "{}"); return h; })(), tmp: dir() }).prepare({})) as AgentRun;

    expect(run.dir).toMatch(new RegExp(`/cp-codex-${process.pid}-`));
  });

  it("is not stopped by a directory it cannot read", () => {
    expect(() => sweepRunHomes(join(dir(), "missing"))).not.toThrow();
  });
});

describe("a home the run made impossible to remove", () => {
  it.skipIf(process.platform !== "darwin")("is removed although the run set an immutable flag on the login copy and on the home", () => {
    const home = dir();
    writeFileSync(join(home, "auth.json"), "{}");
    execFileSync("/usr/bin/chflags", ["uchg", join(home, "auth.json")]);
    execFileSync("/usr/bin/chflags", ["uchg", home]);

    removeRunHome(home);

    expect(existsSync(home)).toBe(false);
  });

  it.skipIf(process.platform !== "darwin")("is removed when an immutable login copy sits in a directory the run made unreadable", () => {
    const home = dir();
    mkdirSync(join(home, "sub"));
    writeFileSync(join(home, "sub", "auth.json"), "{}");
    execFileSync("/usr/bin/chflags", ["uchg", join(home, "sub", "auth.json")]);
    chmodSync(join(home, "sub"), 0o000);

    removeRunHome(home);

    expect(existsSync(home)).toBe(false);
  });

  it.skipIf(process.platform !== "darwin")("is removed when a directory is both unreadable and immutable, with an immutable file inside", () => {
    const home = dir();
    mkdirSync(join(home, "sub"));
    writeFileSync(join(home, "sub", "auth.json"), "{}");
    execFileSync("/usr/bin/chflags", ["uchg", join(home, "sub", "auth.json")]);
    chmodSync(join(home, "sub"), 0o000);
    execFileSync("/usr/bin/chflags", ["uchg", join(home, "sub")]);

    removeRunHome(home);

    expect(existsSync(home)).toBe(false);
  });

  it("says where the login copy is, and that it must go by hand, when it cannot be removed", () => {
    const parent = dir();
    const home = join(parent, "cp-codex-1-x");
    mkdirSync(home);
    writeFileSync(join(home, "auth.json"), "{}");
    chmodSync(parent, 0o500);
    const logged: string[] = [];
    try {
      removeRunHome(home, (message) => logged.push(message));
    } finally {
      chmodSync(parent, 0o700);
    }

    expect(logged).toEqual([expect.stringContaining(`${home}, which holds a copy of the Codex login`)]);
  });
});
