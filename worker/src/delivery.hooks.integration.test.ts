import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelivery, hardenedGitConfig } from "./delivery.js";
import { CommandResult, createRunner, Runner } from "./exec.js";

const HOOK = (marker: string) => `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`;

function pastTheGuard(): Runner {
  const real = createRunner();
  const clean: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false };
  return {
    run: (command, args, opts) =>
      args.includes("config") && args.includes("--list")
        ? Promise.resolve(clean)
        : real.run(command, args, opts),
  };
}

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

  const headSha = (): string =>
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();

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

  it("still pushes the branch", async () => {
    await createDelivery(createRunner()).push(work, "feature", headSha());

    expect(pushedRefs()).toContain("refs/heads/feature");
  });

  it("pushes the commit it was given, not whatever the branch ref was rewritten to point at", async () => {
    const first = headSha();
    writeFileSync(join(work, "b.txt"), "second\n");
    git(work, "add", "b.txt");
    git(work, "commit", "-m", "second");
    const second = headSha();

    git(work, "update-ref", "refs/heads/feature", second);
    git(work, "checkout", "--detach", first);

    await createDelivery(createRunner()).push(work, "feature", first);

    const refs = pushedRefs();
    expect(refs).toContain(first);
    expect(refs).not.toContain(second);
  });

  it("pushes past a pre-push hook the agent planted, without running it", async () => {
    plantHook(join(work, ".git", "hooks", "pre-push"));

    await createDelivery(createRunner()).push(work, "feature", headSha());

    expect(existsSync(marker)).toBe(false);
    expect(pushedRefs()).toContain("refs/heads/feature");
  });

  it("does not run a hook reached through a hooksPath the agent set", async () => {
    plantHook(join(dir, "elsewhere", "pre-push"));
    git(work, "config", "core.hooksPath", join(dir, "elsewhere"));

    await createDelivery(pastTheGuard()).push(work, "feature", headSha());

    expect(existsSync(marker)).toBe(false);
    expect(pushedRefs()).toContain("refs/heads/feature");
  });

  it("blocks hooks through the config alone, without --no-verify", () => {
    plantHook(join(work, ".git", "hooks", "pre-push"));

    execFileSync("git", ["push", "--force-with-lease", "-u", "origin", "--", "feature"], {
      cwd: work,
      env: { ...process.env, ...hardenedGitConfig() },
      stdio: "pipe",
    });

    expect(existsSync(marker)).toBe(false);
  });

  it("does not run a receive-pack program the agent set", async () => {
    const planted = writeProgram(
      join(dir, "planted-receive-pack"),
      `touch ${JSON.stringify(marker)}\nexec git-receive-pack "$@"`
    );
    git(work, "config", "remote.origin.receivepack", planted);

    await createDelivery(pastTheGuard()).push(work, "feature", headSha());

    expect(existsSync(marker)).toBe(false);
    expect(pushedRefs()).toContain("refs/heads/feature");
  });

  it("does not run a credential helper the agent named", async () => {
    git(work, "config", "credential.helper", `!${plantProgram("planted-credential")}`);
    git(work, "remote", "set-url", "origin", unauthorized);

    await createDelivery(pastTheGuard())
      .push(work, "feature", headSha())
      .catch(() => undefined);

    expect(existsSync(marker)).toBe(false);
  });

  it("does not run an askpass program the agent named", async () => {
    git(work, "config", "core.askPass", plantProgram("planted-askpass"));
    git(work, "remote", "set-url", "origin", unauthorized);

    await createDelivery(pastTheGuard())
      .push(work, "feature", headSha())
      .catch(() => undefined);

    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ["remote.origin.pushurl", (p: string) => ["config", "remote.origin.pushurl", `ext::${p}`]],
    ["remote.origin.url", (p: string) => ["config", "remote.origin.url", `ext::${p}`]],
    ["url.insteadOf", (p: string) => ["config", `url.ext::${p}.insteadOf`, "origin-real:"]],
  ])("refuses an ext:: transport reached through %s", async (_name, configure) => {
    const payload = plantProgram("payload");
    git(work, "config", "protocol.ext.allow", "always");
    git(work, ...configure(payload));

    await createDelivery(pastTheGuard())
      .push(work, "feature", headSha())
      .catch(() => undefined);

    expect(existsSync(marker)).toBe(false);
  });

  it("does not run a proxy command the agent set, and still pushes over it", async () => {
    git(work, "config", "core.gitProxy", plantProgram("planted-proxy"));

    await createDelivery(pastTheGuard()).push(work, "feature", headSha());

    expect(existsSync(marker)).toBe(false);
    expect(pushedRefs()).toContain("refs/heads/feature");
  });

  describe("and refuses the push outright when it can see one", () => {
    it.each([
      ["core.hooksPath", () => git(work, "config", "core.hooksPath", join(dir, "elsewhere"))],
      [
        "remote.origin.receivepack",
        () => git(work, "config", "remote.origin.receivepack", "/bin/true"),
      ],
      ["core.gitProxy", () => git(work, "config", "core.gitProxy", "/bin/true")],
    ])("names %s, and the remote never hears from it", async (key, plant) => {
      plant();

      await expect(createDelivery(createRunner()).push(work, "feature", headSha())).rejects.toThrow(
        new RegExp(key.toLowerCase().replace(/\./g, "\\."))
      );

      expect(pushedRefs()).not.toContain("refs/heads/feature");
    });

    it("refuses when it cannot read the config at all", async () => {
      const runner: Runner = {
        run: (command, args, opts) =>
          args.includes("config") && args.includes("--list")
            ? Promise.resolve({ code: 128, stdout: "", stderr: "boom", timedOut: false })
            : createRunner().run(command, args, opts),
      };

      await expect(createDelivery(runner).push(work, "feature", headSha())).rejects.toThrow(/unreadable/);

      expect(pushedRefs()).not.toContain("refs/heads/feature");
    });
  });

  it("refuses to push to a local path, where a post-receive hook would hold its credentials", async () => {
    const destination = join(dir, "agents-own.git");
    execFileSync("git", ["init", "--bare", "-b", "main", destination], { stdio: "pipe" });
    plantHook(join(destination, "hooks", "post-receive"));
    git(work, "config", "remote.origin.pushurl", destination);

    await createDelivery(pastTheGuard())
      .push(work, "feature", headSha())
      .catch(() => undefined);

    expect(existsSync(marker)).toBe(false);
  });
});
