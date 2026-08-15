import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelivery, hardenedGitConfig } from "./delivery.js";
import { createRunner } from "./exec.js";

/**
 * Delivery carries the operator's credentials and runs `git push` inside the worktree the agent
 * just wrote. Everything git treats as "run this program" — hooks, credential.helper, askpass,
 * receivepack — and everything that decides *where* the push goes is therefore attacker-controlled.
 * A linked worktree shares config and hooks with the main clone, so what is planted outlives the run.
 *
 * Real git against real repositories, over a real transport: the question is what git does with a
 * config file, and a mocked runner could only show that the flags were spelled correctly.
 *
 * The remote is `git://` rather than a local path, because delivery refuses local transports — a
 * local push runs git-receive-pack as its own child, and the destination's post-receive hook would
 * then hold delivery's credentials. Under git:// that hook runs inside the daemon instead, which
 * the agent could start but which never sees our environment.
 */

// Refuses the push as well as marking that it ran: with `exit 0` an unhardened push still reaches
// the remote, so an assertion that the branch landed could not tell the two apart
const HOOK = (marker: string) => `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function writeProgram(path: string, body: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = tcpServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

describe("delivery does not execute what the agent left in the repository", () => {
  let dir: string;
  let origin: string;
  let work: string;
  let marker: string;
  let daemon: ChildProcess;
  let challenge: Server;
  let unauthorized: string;

  const pushedRefs = (): string =>
    execFileSync("git", ["ls-remote", origin], { encoding: "utf8" });

  const plantProgram = (name: string): string =>
    writeProgram(join(dir, name), `touch ${JSON.stringify(marker)}\nexit 0`);

  const plantHook = (path: string): void => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, HOOK(marker));
    chmodSync(path, 0o755);
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "bp308-"));
    origin = join(dir, "origin.git");
    work = join(dir, "work");
    marker = join(dir, "the-planted-program-ran");

    execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });

    const port = await freePort();
    daemon = spawn(
      "git",
      [
        "daemon",
        "--export-all",
        "--enable=receive-pack",
        `--base-path=${dir}`,
        `--port=${port}`,
        "--listen=127.0.0.1",
        dir,
      ],
      { stdio: "pipe" }
    );
    await new Promise((resolve) => setTimeout(resolve, 700));

    execFileSync("git", ["clone", `git://127.0.0.1:${port}/origin.git`, work], { stdio: "pipe" });
    git(work, "config", "user.email", "worker@example.com");
    git(work, "config", "user.name", "worker");
    writeFileSync(join(work, "a.txt"), "hello\n");
    git(work, "add", "a.txt");
    git(work, "commit", "-m", "first");
    git(work, "checkout", "-b", "feature");

    // Answers 401, which is what makes git go looking for a program to get a password from
    challenge = httpServer((_req, res) => {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      res.end();
    });
    await new Promise<void>((resolve) => challenge.listen(0, "127.0.0.1", () => resolve()));
    unauthorized = `http://127.0.0.1:${(challenge.address() as AddressInfo).port}/repo.git`;
  });

  afterEach(async () => {
    daemon.kill();
    await new Promise<void>((resolve) => challenge.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  // Hardening that also stopped the branch reaching the remote would be found in production
  it("still pushes the branch", async () => {
    await createDelivery(createRunner()).push(work, "feature");

    expect(pushedRefs()).toContain("refs/heads/feature");
  });

  // A gate rejection pushes too, so a planted hook must neither run nor keep the branch back. The
  // hook refuses the push, which is what makes the second assertion bite.
  it("pushes past a pre-push hook the agent planted, without running it", async () => {
    plantHook(join(work, ".git", "hooks", "pre-push"));

    await createDelivery(createRunner()).push(work, "feature");

    expect(existsSync(marker)).toBe(false);
    expect(pushedRefs()).toContain("refs/heads/feature");
  });

  it("does not run a hook reached through a hooksPath the agent set", async () => {
    plantHook(join(dir, "elsewhere", "pre-push"));
    git(work, "config", "core.hooksPath", join(dir, "elsewhere"));

    await createDelivery(createRunner()).push(work, "feature");

    expect(existsSync(marker)).toBe(false);
    expect(pushedRefs()).toContain("refs/heads/feature");
  });

  // core.hooksPath alone, with no --no-verify in sight: the two mechanisms would otherwise mask
  // each other, and dropping either would leave every other test here green
  it("blocks hooks through the config alone, without --no-verify", () => {
    plantHook(join(work, ".git", "hooks", "pre-push"));

    execFileSync("git", ["push", "--force-with-lease", "-u", "origin", "--", "feature"], {
      cwd: work,
      env: { ...process.env, ...hardenedGitConfig() },
      stdio: "pipe",
    });

    expect(existsSync(marker)).toBe(false);
  });

  // git keeps the *first* receivepack it is given, not the last, so config cannot override this
  // one — it has to be won on the command line
  it("does not run a receive-pack program the agent set", async () => {
    const planted = writeProgram(
      join(dir, "planted-receive-pack"),
      `touch ${JSON.stringify(marker)}\nexec git-receive-pack "$@"`
    );
    git(work, "config", "remote.origin.receivepack", planted);

    await createDelivery(createRunner()).push(work, "feature");

    expect(existsSync(marker)).toBe(false);
    expect(pushedRefs()).toContain("refs/heads/feature");
  });

  it("does not run a credential helper the agent named", async () => {
    git(work, "config", "credential.helper", `!${plantProgram("planted-credential")}`);
    git(work, "remote", "set-url", "origin", unauthorized);

    await createDelivery(createRunner())
      .push(work, "feature")
      .catch(() => undefined);

    expect(existsSync(marker)).toBe(false);
  });

  it("does not run an askpass program the agent named", async () => {
    git(work, "config", "core.askPass", plantProgram("planted-askpass"));
    git(work, "remote", "set-url", "origin", unauthorized);

    await createDelivery(createRunner())
      .push(work, "feature")
      .catch(() => undefined);

    expect(existsSync(marker)).toBe(false);
  });

  // The way through was the transport, not the configuration: ext:: hands the URL to a program.
  // Three ways to rewrite where the push goes, one chokepoint that stops all of them.
  it.each([
    ["remote.origin.pushurl", (p: string) => ["config", "remote.origin.pushurl", `ext::${p}`]],
    ["remote.origin.url", (p: string) => ["config", "remote.origin.url", `ext::${p}`]],
    ["url.insteadOf", (p: string) => ["config", `url.ext::${p}.insteadOf`, "origin-real:"]],
  ])("refuses an ext:: transport reached through %s", async (_name, configure) => {
    const payload = plantProgram("payload");
    git(work, "config", "protocol.ext.allow", "always");
    git(work, ...configure(payload));

    await createDelivery(createRunner())
      .push(work, "feature")
      .catch(() => undefined);

    expect(existsSync(marker)).toBe(false);
  });

  // A local push runs git-receive-pack as delivery's own child, so the destination's post-receive
  // hook would hold delivery's credentials. Refusing the transport is what stops it — asserted,
  // because the first version of this fix assumed the hooksPath override covered it, and it does not.
  it("refuses to push to a local path, where a post-receive hook would hold its credentials", async () => {
    const destination = join(dir, "agents-own.git");
    execFileSync("git", ["init", "--bare", "-b", "main", destination], { stdio: "pipe" });
    plantHook(join(destination, "hooks", "post-receive"));
    git(work, "config", "remote.origin.pushurl", destination);

    await createDelivery(createRunner())
      .push(work, "feature")
      .catch(() => undefined);

    expect(existsSync(marker)).toBe(false);
  });
});
