import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll, resolveCommitIdentity } from "./commit.js";
import { createRunner } from "./exec.js";

/**
 * BP-516. Neutralising `~/.gitconfig` on the calls that stage and commit takes `user.email` with
 * it, and git refuses to commit without one — measured: "Author identity unknown", exit 128, no
 * commit. So the identity is resolved before the agent runs and handed to `commitAll`.
 *
 * Real git, because every claim here is about which configuration git itself consults: a mocked
 * runner would answer whatever it was told about a file it never opened.
 */
describe("who the worker's commits are by", () => {
  let dir: string;
  let work: string;
  let home: string;
  let realHome: string | undefined;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, HOME: home } }).toString();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bp516-identity-"));
    work = join(dir, "work");
    home = join(dir, "home");
    mkdirSync(home);
    // The operator's own identity, in the file this worker's git no longer reads
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = The Operator\n\temail = operator@example.com\n");
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { stdio: "pipe" });
    writeFileSync(join(work, "a.txt"), "a\n");
    realHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    // Assigned back rather than deleted: assigning an undefined stores the string "undefined"
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(dir, { recursive: true, force: true });
  });

  // The premise for all of it, and the reason this is not "a tidy-up we could skip": with the
  // global file out of the picture and no identity handed over, there is nobody to commit as.
  it("cannot commit at all when nobody was named", async () => {
    await expect(commitAll(createRunner(), work, "BP-516: work")).rejects.toThrow(
      /git commit failed[\s\S]*identity/i
    );
  });

  it("commits as the identity the operator configured", async () => {
    const identity = await resolveCommitIdentity(createRunner(), work);

    const sha = await commitAll(createRunner(), work, "BP-516: work", identity);

    expect(identity).toEqual({ name: "The Operator", email: "operator@example.com" });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(work, "log", "-1", "--format=%an <%ae>").trim()).toBe("The Operator <operator@example.com>");
    // The committer too: `git log --format=%an` would read the same for a commit whose committer
    // is somebody else entirely, and a commit with no committer is refused just as loudly.
    expect(git(work, "log", "-1", "--format=%cn <%ce>").trim()).toBe("The Operator <operator@example.com>");
  });

  // An operator who keeps a different address in one repository keeps it: the identity is read
  // where the commits are made rather than from the machine's own global file.
  it("prefers what the checkout itself says over the machine's default", async () => {
    git(work, "config", "user.name", "Repo Name");
    git(work, "config", "user.email", "repo@example.com");

    const identity = await resolveCommitIdentity(createRunner(), work);
    await commitAll(createRunner(), work, "BP-516: work", identity);

    // Both halves: what was resolved, and what the commit carries. The local config would supply
    // the second on its own — it survives `GIT_CONFIG_GLOBAL=/dev/null` — so without the first
    // this case passes against a resolution that never looked at the checkout.
    expect(identity).toEqual({ name: "Repo Name", email: "repo@example.com" });
    expect(git(work, "log", "-1", "--format=%an <%ae>").trim()).toBe("Repo Name <repo@example.com>");
  });
});
