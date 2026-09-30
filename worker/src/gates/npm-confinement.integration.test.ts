import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner } from "../exec.js";
import { claimedTask } from "../__fixtures__/task.js";
import { GateContext } from "../types.js";
import { testRunGate } from "./test-run.js";
import { buildGate } from "./build.js";
import { LOOPBACK_ONLY_NOTE, runConfinedNpm } from "./confined-npm.js";
import { installedToolPath } from "../__fixtures__/tool-paths.js";
import { recordDir } from "../sandbox.js";

/**
 * BP-608, driven through the real kernel and a real `npm`.
 *
 * The chain BP-349 lengthened rather than closed: an Implement step writes a test file that writes
 * `$HOME/.claude/settings.json` — the write is inside the worktree, so the agent's own sandbox
 * permits it, and it is a *test*, which is exactly what the Test-presence gate asks for — and then
 * the Test gate executes it as the worker's uid, outside any profile. A later Implement step in
 * the same sequence loads the hook.
 *
 * A unit test can only say which arguments were composed, which is the shape of assertion that let
 * the hole stand while the profile was already there. This runs the suite.
 *
 * Skipped off macOS: there is no seatbelt to ask, and the gate refuses there — a refusal the unit
 * suite pins.
 */
const onMac = process.platform === "darwin";

describe.skipIf(!onMac)("the test gate against the real sandbox", () => {
  let dir = "";
  let worktree = "";
  let outside = "";

  const runner = createRunner();
  const npmPath = onMac ? installedToolPath("npm") : "";

  function context(): GateContext {
    return {
      worktreePath: worktree,
      worktreeDir: recordDir(worktree),
      task: claimedTask({ title: "t", description: "d" }),
      result: {
        status: "completed",
        summary: "",
        filesChanged: [],
        testsAdded: [],
        blockedReason: "",
      },
      diff: {
        changedLines: 1,
        changedFiles: ["a.js"],
        patch: "",
        truncated: false,
        headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
        symlinks: [],
        suppressedDiffs: [], gitlinks: [],
      },
    };
  }

  /** A worktree whose `npm test` runs this script, the way an agent's test file would. */
  function suiteThat(script: string) {
    writeFileSync(
      join(worktree, "package.json"),
      JSON.stringify({ name: "wt", version: "1.0.0", scripts: { test: `node test.js` } })
    );
    writeFileSync(join(worktree, "test.js"), script);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp608-"));
    worktree = join(dir, "worktree");
    outside = join(dir, "home");
    mkdirSync(worktree);
    mkdirSync(outside);
    // `$HOME/.claude/settings.json`, played by a file this test owns
    writeFileSync(join(outside, "settings.json"), "original\n");
  });

  afterEach(() => {
    spawnSync("/usr/bin/pkill", ["-9", "-f", dir]);
    rmSync(dir, { recursive: true, force: true });
  });

  // BP-796: a detached child is a new session, out of reach of the group the gate's timeout kills
  it("leaves nothing the suite started writing into the worktree once the gate returns", async () => {
    const planted = join(worktree, "planted");
    const writer = `setInterval(() => require("fs").appendFileSync(${JSON.stringify(planted)}, "x"), 50)`;
    suiteThat(`
      const { spawn } = require("child_process");
      const fs = require("fs");
      spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], { detached: true, stdio: "ignore" }).unref();
      const wait = () => (fs.existsSync(${JSON.stringify(planted)}) ? process.exit(0) : setTimeout(wait, 20));
      wait();
    `);

    const verdict = await testRunGate(runner, npmPath, 60_000).run(context());

    expect(verdict.ok).toBe(true);
    const size = statSync(planted).size;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(statSync(planted).size).toBe(size);
  }, 90_000);

  it("does not let the suite write the file a hook would live in", async () => {
    suiteThat(
      `require("fs").writeFileSync(${JSON.stringify(join(outside, "settings.json"))}, "planted");`
    );

    const result = await testRunGate(runner, npmPath, 120_000).run(context());

    // The suite fails because the write was denied, which is also how the operator finds out
    expect(result.ok).toBe(false);
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("original\n");
  });

  it("does not let it create one either, where none existed", async () => {
    const planted = join(outside, "new-hook.json");
    suiteThat(`require("fs").writeFileSync(${JSON.stringify(planted)}, "planted");`);

    const result = await testRunGate(runner, npmPath, 120_000).run(context());

    expect(result.ok).toBe(false);
    expect(existsSync(planted)).toBe(false);
  });

  /**
   * The path the ticket is actually about, in the tree it is actually in: `$HOME`. The two above
   * are under the machine's temp tree, which this confinement also denies — a run gets a scratch
   * directory of its own rather than all of `/var/folders` — so without this the suite would not
   * be exercising the home directory at all.
   */
  it("does not let the suite write into the operator's home directory", async () => {
    const home = mkdtempSync(join(homedir(), "bp608-home-"));
    const planted = join(home, "settings.json");
    writeFileSync(planted, "original\n");
    suiteThat(`require("fs").writeFileSync(${JSON.stringify(planted)}, "planted");`);

    try {
      const result = await testRunGate(runner, npmPath, 120_000).run(context());

      expect(result.ok).toBe(false);
      expect(readFileSync(planted, "utf8")).toBe("original\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The control, and the reason the confinement is not simply "deny everything": a suite that
  // writes fixtures, snapshots or coverage into its own repository still passes.
  it("lets an honest suite write inside the worktree", async () => {
    suiteThat(
      `require("fs").writeFileSync(${JSON.stringify(join(worktree, "coverage.txt"))}, "100%");`
    );

    const result = await testRunGate(runner, npmPath, 120_000).run(context());

    expect(result.ok, result.reason).toBe(true);
    expect(readFileSync(join(worktree, "coverage.txt"), "utf8")).toBe("100%");
  });

  // The other half of honest: a suite that writes outside the repository on purpose, which is
  // ordinary, and which a confinement that broke it would get switched off for.
  it("lets an honest suite write to a temp directory", async () => {
    suiteThat(
      `const {mkdtempSync, writeFileSync} = require("fs");
       const {tmpdir} = require("os");
       const {join} = require("path");
       writeFileSync(join(mkdtempSync(join(tmpdir(), "suite-")), "scratch.txt"), "fine");`
    );

    const result = await testRunGate(runner, npmPath, 120_000).run(context());

    expect(result.ok, result.reason).toBe(true);
  });

  // BP-720: what a test that read a credential under HOME would do next. TEST-NET-1 is never
  // routed, so an open network times out rather than answering EPERM; sandbox.integration.test.ts
  // holds the open-mode control.
  const SEND_OFF_MACHINE = `require("net").connect({ host: "192.0.2.1", port: 443, timeout: 2000 })
    .on("connect", () => process.exit(0))
    .on("timeout", () => process.exit(0))
    .on("error", (error) => { console.error("send failed: " + error.code); process.exit(1); });`;

  it("refuses a suite's connection off the machine, and says the network was loopback-only", async () => {
    suiteThat(SEND_OFF_MACHINE);

    const result = await testRunGate(runner, npmPath, 120_000).run(context());

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("send failed: EPERM");
    expect(result.reason).toContain(LOOPBACK_ONLY_NOTE);
  });

  it("lets an honest suite serve and fetch on loopback", async () => {
    suiteThat(
      `const server = require("http").createServer((_, res) => res.end("pong")).listen(0, "127.0.0.1", async () => {
         const body = await (await fetch("http://127.0.0.1:" + server.address().port + "/")).text();
         server.close();
         process.exit(body === "pong" ? 0 : 1);
       });`
    );

    const result = await testRunGate(runner, npmPath, 120_000).run(context());

    expect(result.ok, result.reason).toBe(true);
  });

  describe("the build gate", () => {
    function buildThat(script: string) {
      const pkg = { name: "wt", version: "1.0.0" };
      writeFileSync(join(worktree, "package.json"), JSON.stringify({ ...pkg, scripts: { build: "node build.js" } }));
      writeFileSync(
        join(worktree, "package-lock.json"),
        JSON.stringify({ ...pkg, lockfileVersion: 3, requires: true, packages: { "": pkg } })
      );
      writeFileSync(join(worktree, "build.js"), script);
    }

    it("refuses the build script's connection off the machine", async () => {
      buildThat(SEND_OFF_MACHINE);

      const result = await buildGate(runner, npmPath, 120_000).run(context());

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/^build failed/);
      expect(result.reason).toContain("send failed: EPERM");
    });

    it("lets an honest build write its output", async () => {
      buildThat(`require("fs").writeFileSync("dist.js", "built");`);

      const result = await buildGate(runner, npmPath, 120_000).run(context());

      expect(result.ok, result.reason).toBe(true);
      expect(readFileSync(join(worktree, "dist.js"), "utf8")).toBe("built");
    });
  });

  /**
   * BP-720. The install keeps the network, and a project `.npmrc` is read from the worktree — one
   * the agent committed, or one an earlier gate's code left untracked, which reaches no diff. The
   * operator's `~/.npmrc` is played by a fake HOME holding a dummy token.
   */
  describe("the install, against a project .npmrc", () => {
    let seen: { url: string; authorization: string }[] = [];
    let listener: Server;
    let port = 0;
    let home = "";

    beforeAll(async () => {
      listener = createServer((req, res) => {
        seen.push({ url: req.url ?? "", authorization: String(req.headers.authorization ?? "") });
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
      port = (listener.address() as AddressInfo).port;
    });

    afterAll(() => {
      listener.close();
    });

    beforeEach(() => {
      seen = [];
      home = join(dir, "fake-home");
      mkdirSync(home);
    });

    const install = () =>
      runConfinedNpm(runner, npmPath, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=0"], {
        cwd: worktree,
        worktree: recordDir(worktree),
        timeoutMs: 120_000,
        withCache: true,
        env: { PATH: process.env.PATH, HOME: home, USER: process.env.USER, TMPDIR: process.env.TMPDIR, CP_NPM_CACHE: join(dir, "cache") },
      });

    function project(dependencies: Record<string, string>, locked: Record<string, object>) {
      const pkg = { name: "wt", version: "1.0.0", dependencies };
      writeFileSync(join(worktree, "package.json"), JSON.stringify(pkg));
      writeFileSync(
        join(worktree, "package-lock.json"),
        JSON.stringify({ ...pkg, lockfileVersion: 3, requires: true, packages: { "": pkg, ...locked } })
      );
    }

    it("does not hand the operator's registry token to a proxy the project names", async () => {
      const registry = `http://127.0.0.1:${port}/registry/`;
      writeFileSync(join(home, ".npmrc"), `//127.0.0.1:${port}/registry/:_authToken=DUMMY-TOKEN\n`);
      writeFileSync(join(worktree, ".npmrc"), `registry=${registry}\nproxy=http://127.0.0.1:${port}/proxy/\nhttps-proxy=http://127.0.0.1:${port}/proxy/\n`);
      project({ x: "1.0.0" }, { "node_modules/x": { version: "1.0.0", resolved: `${registry}x/-/x-1.0.0.tgz` } });

      await install();

      // Through a proxy the request line is the absolute URL; direct, it is the path
      expect(seen.length, "npm never asked for the tarball, so this proves nothing").toBeGreaterThan(0);
      expect(seen.filter((request) => request.url.startsWith("http://"))).toEqual([]);
    });

    it("does not run a git binary the project names, and still installs a git dependency", async () => {
      const dep = join(dir, "dep");
      mkdirSync(dep);
      writeFileSync(join(dep, "package.json"), JSON.stringify({ name: "gitdep", version: "1.0.0" }));
      const git = (...args: string[]) =>
        execFileSync(installedToolPath("git"), ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dep, encoding: "utf8" }).trim();
      git("init", "-q");
      git("add", ".");
      git("commit", "-qm", "init");
      const sha = git("rev-parse", "HEAD");

      const planted = join(worktree, "planted-git.sh");
      writeFileSync(planted, `#!/bin/sh\necho ran > ${JSON.stringify(join(worktree, "GIT-SCRIPT-RAN"))}\nexec ${installedToolPath("git")} "$@"\n`, { mode: 0o755 });
      writeFileSync(join(worktree, ".npmrc"), `git=${planted}\n`);
      project({ gitdep: `git+file://${dep}` }, { "node_modules/gitdep": { version: "1.0.0", resolved: `git+file://${dep}#${sha}` } });

      const result = await install();

      expect(existsSync(join(worktree, "GIT-SCRIPT-RAN"))).toBe(false);
      expect("code" in result && result.code, JSON.stringify(result)).toBe(0);
      expect(existsSync(join(worktree, "node_modules", "gitdep", "package.json"))).toBe(true);
    });
  });
});
