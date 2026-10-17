import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutor } from "../executor.js";
import { createRunner } from "../exec.js";
import { UNCONFINED_ESCAPE_HATCH } from "../env.js";
import { recordDir } from "../sandbox.js";
import { claimedTask } from "../__fixtures__/task.js";
import { workerConfig } from "../__fixtures__/config.js";
import { codexAgent } from "./codex.js";

/**
 * BP-987. The adapter's confinement driven through the real kernel, with a stand-in for the CLI that
 * tries each write a Codex shell could make and reports which were refused. A test over the argv or
 * over the profile string cannot say what seatbelt permits (sandbox.integration.test.ts opens the
 * same way); the stand-in is the only thing here that is not real, and it is a node script because
 * it has to run offline and must not use anyone's login.
 *
 * What was measured against the real Codex CLI is written up on BP-987 and in agents/codex.ts.
 * Skipped off macOS, where `confine` refuses and there is no seatbelt to ask.
 */
const onMac = process.platform === "darwin";

describe.skipIf(!onMac)("a codex step against the real sandbox", { timeout: 90_000 }, () => {
  const made: string[] = [];
  const homeProbe = join(homedir(), ".bp987-codex-test");
  let worktree: string;
  let outside: string;
  let operatorHome: string;
  let tmp: string;
  let fake: string;

  const make = () => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), "bp987-int-")));
    made.push(path);
    return path;
  };

  beforeEach(() => {
    vi.stubEnv(UNCONFINED_ESCAPE_HATCH, "");
    worktree = make();
    outside = make();
    tmp = make();
    operatorHome = make();
    writeFileSync(join(operatorHome, "auth.json"), '{"tokens":"secret"}');
    writeFileSync(join(operatorHome, "config.toml"), "# the operator's own\n");
    fake = join(make(), "codex");
    writeFileSync(
      fake,
      `#!${process.execPath}
const fs = require("fs");
const result = {};
const attempt = (name, write) => { try { write(); result[name] = "ok"; } catch (error) { result[name] = error.code || "error"; } };
attempt("worktree", () => fs.writeFileSync("inside.txt", "a"));
attempt("outside", () => fs.writeFileSync(${JSON.stringify(join(outside, "a.txt"))}, "a"));
attempt("home", () => fs.writeFileSync(${JSON.stringify(homeProbe)}, "a"));
attempt("operatorConfig", () => fs.appendFileSync(${JSON.stringify(join(operatorHome, "config.toml"))}, "# planted\\n"));
attempt("runHome", () => fs.writeFileSync(process.env.CODEX_HOME + "/state.txt", "a"));
result.homeFiles = fs.readdirSync(process.env.CODEX_HOME).sort();
const message = { status: "completed", summary: JSON.stringify(result), filesChanged: [], testsAdded: [], blockedReason: "" };
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(message) } }));
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    );
    chmodSync(fake, 0o755);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeProbe, { force: true });
    for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  async function step(capability: "edit" | "read-only") {
    const executor = createExecutor(workerConfig(), createRunner(), codexAgent(fake, { sourceHome: operatorHome, tmp }));
    const outcome = await executor.execute({
      task: claimedTask({}),
      worktreePath: worktree,
      worktreeDir: recordDir(worktree),
      brief: { prompt: "do it", capability, model: "gpt-x", fallbackModel: "", timeoutMs: 60_000 },
    });
    if (outcome.kind !== "result") throw new Error(`no result: ${JSON.stringify(outcome)}`);
    return JSON.parse(outcome.result.summary) as Record<string, unknown>;
  }

  it("lets an editing step write in the worktree and in its own home, and nowhere else", async () => {
    const attempts = await step("edit");

    expect(attempts).toMatchObject({ worktree: "ok", runHome: "ok", outside: "EPERM", home: "EPERM", operatorConfig: "EPERM" });
    expect(existsSync(join(worktree, "inside.txt"))).toBe(true);
    expect(existsSync(join(outside, "a.txt"))).toBe(false);
    expect(existsSync(homeProbe)).toBe(false);
    expect(readFileSync(join(operatorHome, "config.toml"), "utf8")).toBe("# the operator's own\n");
  });

  it("lets a read-only step write nothing in the worktree either", async () => {
    const attempts = await step("read-only");

    expect(attempts).toMatchObject({ worktree: "EPERM", runHome: "ok", outside: "EPERM", home: "EPERM", operatorConfig: "EPERM" });
    expect(existsSync(join(worktree, "inside.txt"))).toBe(false);
  });

  it("gives the step its login and its schema in a home of its own, and none of the operator's config", async () => {
    const attempts = await step("edit");

    expect(attempts.homeFiles).toEqual(["auth.json", "schema.json", "state.txt"]);
  });

  it("leaves no copy of the login behind", async () => {
    await step("edit");

    expect(readdirSync(tmp).filter((name) => name.startsWith("cp-codex-"))).toEqual([]);
  });

  // The control for the refusals above, which are "this write did not happen" and would be as true
  // of a stand-in that never tried: with the operator's own risk acceptance switched on, the same
  // script writes everywhere, so a green test above is the profile's doing
  it("would have written everywhere without the sandbox", async () => {
    vi.stubEnv(UNCONFINED_ESCAPE_HATCH, "1");

    const attempts = await step("read-only");

    expect(attempts).toMatchObject({ worktree: "ok", outside: "ok", home: "ok", operatorConfig: "ok" });
  });
});
