import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelivery } from "./delivery.js";
import { createRunner } from "./exec.js";

/**
 * Delivery is the one place that carries the operator's credentials, and it runs `git push` inside
 * the worktree the agent just wrote. Everything git treats as "run this program" — hooks,
 * credential.helper, core.sshCommand, core.pager — is therefore attacker-controlled input, and a
 * linked worktree shares config and hooks with the main clone, so what is planted outlives the run.
 *
 * A real git against a real repository, because the whole question is what git does with a config
 * file: a mocked runner would only prove that the flags were spelled correctly.
 */

const HOOK = (marker: string) => `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function plantHook(path: string, marker: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, HOOK(marker));
  chmodSync(path, 0o755);
}

describe("delivery does not execute what the agent left in the repository", () => {
  let dir: string;
  let origin: string;
  let work: string;
  let marker: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp308-"));
    origin = join(dir, "origin.git");
    work = join(dir, "work");
    marker = join(dir, "the-hook-ran");

    execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
    execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
    git(work, "config", "user.email", "worker@example.com");
    git(work, "config", "user.name", "worker");
    writeFileSync(join(work, "a.txt"), "hello\n");
    git(work, "add", "a.txt");
    git(work, "commit", "-m", "first");
    git(work, "checkout", "-b", "feature");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("does not run a pre-push hook planted in the worktree", async () => {
    plantHook(join(work, ".git", "hooks", "pre-push"), marker);

    await createDelivery(createRunner()).push(work, "feature");

    expect(existsSync(marker)).toBe(false);
  });

  it("does not run a hook reached through a hooksPath the agent set", async () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    plantHook(join(elsewhere, "pre-push"), marker);
    git(work, "config", "core.hooksPath", elsewhere);

    await createDelivery(createRunner()).push(work, "feature");

    expect(existsSync(marker)).toBe(false);
  });

  // The point of the flags is to make the push safe, not to make it fail: a hardening that also
  // stops the branch reaching the remote would be found in production rather than here
  it("still pushes the branch", async () => {
    await createDelivery(createRunner()).push(work, "feature");

    const refs = execFileSync("git", ["ls-remote", origin], { encoding: "utf8" });
    expect(refs).toContain("refs/heads/feature");
  });

  it("pushes even with a hook planted, so a rejected run still reaches the remote", async () => {
    plantHook(join(work, ".git", "hooks", "pre-push"), marker);

    await createDelivery(createRunner()).push(work, "feature");

    const refs = execFileSync("git", ["ls-remote", origin], { encoding: "utf8" });
    expect(refs).toContain("refs/heads/feature");
    expect(existsSync(marker)).toBe(false);
  });
});
