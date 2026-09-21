import { describe, it, expect, vi } from "vitest";
import { commitAll, resolveCommitIdentity, TamperedCheckoutError } from "./commit.js";
import { scopedConfigListZ } from "./config-list.fixtures.js";

const gitPath = "git";

type Result = { code: number; stdout?: string; stderr?: string };

function runnerFor(...results: Result[]) {
  const run = vi.fn();
  for (const result of results) {
    run.mockResolvedValueOnce({ timedOut: false, stdout: "", stderr: "", ...result });
  }
  return { runner: { run } as never, run };
}

// commitAll's first calls are the pre-staging config scan (BP-403), so every case that expects to
// reach `status` needs clean answers for it first. Two of them since BP-346: one asking whether
// this repository's own config can be read at all, one reading the effective config. The cases
// below read as though they start at status; only the scan's own tests use runnerFor directly.
// Found by subcommand rather than by index: two calls were prepended in BP-403 and a third in
// BP-346, and each time every index-based assertion below moved with it while still reading as
// though it named a call
function callWith(run: ReturnType<typeof vi.fn>, subcommand: string): string[] {
  const call = run.mock.calls.find(([, args]) => (args as string[]).includes(subcommand));
  if (!call) throw new Error(`git ${subcommand} was never run`);
  return call[1] as string[];
}

function runnerReturning(...results: Result[]) {
  return runnerFor(readableConfig, noPlantedConfig, ...results);
}

const clean = { code: 0, stdout: "" };
// BP-346: the scan reads `--list --show-scope --no-includes`, so every line git returns is
// `<scope>\t<key>=<value>` — a fixture without the scope describes an answer git no longer gives
const local = (...lines: string[]) => scopedConfigListZ(lines.join("\n"));
// `--local --list` without `-z`: plain lines, and only the exit code is read. The scoped listing
// below is the one that is parsed, and it is the one `scopedConfigListZ` frames.
const readableConfig = { code: 0, stdout: "core.bare=false\n" };
const noPlantedConfig = { code: 0, stdout: local("core.bare=false", "filter.lfs.required=true") };
const dirty = { code: 0, stdout: " M src/a.ts\n" };

// Required since BP-516: `~/.gitconfig` is out of the picture on these calls, so the only identity
// a commit can carry is the one the run resolved before the agent started.
const IDENTITY = { name: "Worker", email: "worker@example.com" };

describe("commitAll", () => {
  it("does nothing when the agent left the tree clean", async () => {
    const { runner, run } = runnerReturning(clean);
    await commitAll(runner, gitPath, "/wt", "BP-1: something", IDENTITY);
    // The two scan calls and `status`, and nothing after it
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("stages everything and commits when there is something to commit", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, clean);
    await commitAll(runner, gitPath, "/wt", "BP-1: something", IDENTITY);
    expect(callWith(run, "add")).toContain("add");
    expect(callWith(run, "commit")).toContain("BP-1: something");
  });

  // The agent can write .git/hooks/pre-commit with the Write tool it needs for the task itself
  it("runs no hook of the agent's, on any call", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, clean);
    await commitAll(runner, gitPath, "/wt", "m", IDENTITY);
    for (const call of run.mock.calls) {
      expect(call[1]).toContain("core.hooksPath=/dev/null");
    }
    expect(callWith(run, "commit")).toContain("--no-verify");
  });

  it("throws when the commit fails, rather than reporting a run that committed nothing", async () => {
    const { runner } = runnerReturning(dirty, clean, { code: 1, stderr: "nope" });
    await expect(commitAll(runner, gitPath, "/wt", "m", IDENTITY)).rejects.toThrow(/nope/);
  });

  it("throws when git status itself fails, rather than reading silence as a clean tree", async () => {
    const { runner } = runnerReturning({ code: 128, stderr: "not a repository" });
    await expect(commitAll(runner, gitPath, "/wt", "m", IDENTITY)).rejects.toThrow(/not a repository/);
  });

  // -m takes the next argument, so a subject beginning with a dash would otherwise be read as one
  it("keeps the message out of git's option slot", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, clean);
    await commitAll(runner, gitPath, "/wt", "--amend", IDENTITY);
    const args = callWith(run, "commit");
    expect(args[args.indexOf("-m") + 1]).toBe("--amend");
  });

  it("returns the sha it created", async () => {
    const { runner } = runnerReturning(dirty, clean, clean, { code: 0, stdout: "abc123\n" });
    expect(await commitAll(runner, gitPath, "/wt", "BP-1: edit", IDENTITY)).toBe("abc123");
  });

  it("returns an empty string when there was nothing to commit", async () => {
    const { runner } = runnerReturning(clean);
    expect(await commitAll(runner, gitPath, "/wt", "BP-1: edit", IDENTITY)).toBe("");
  });

  it("throws when rev-parse fails, rather than reporting a run with no sha", async () => {
    const { runner } = runnerReturning(dirty, clean, clean, { code: 1, stderr: "no HEAD" });
    await expect(commitAll(runner, gitPath, "/wt", "m", IDENTITY)).rejects.toThrow(/no HEAD/);
  });
});

/**
 * BP-403. Between bindRepository's scan and this call the agent can write `.git/config` and
 * `.git/info/attributes`, and git then runs its program while the worker stages the work. The
 * refusal has to happen before anything reads the working tree — commit.planted-filter.integration
 * proves what real git does; these prove the ordering and the message.
 */
describe("commitAll against a planted config", () => {
  for (const leaf of ["clean", "smudge", "process"]) {
    it(`refuses before it reads the tree when filter.z.${leaf} is set`, async () => {
      const { runner, run } = runnerFor(readableConfig, { code: 0, stdout: local(`filter.z.${leaf}=/tmp/payload.sh`) });
      await expect(commitAll(runner, gitPath, "/wt", "m", IDENTITY)).rejects.toThrow(
        new RegExp(`refusing to stage.*filter\\.z\\.${leaf}`)
      );
      // The scan and nothing else: no status, no add, so no call that reads a file's content
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1][1]).toContain("--show-scope");
    });
  }

  // Refused, and refused as the ordinary failure it is: a config git would not read is a checkout
  // being re-cloned or a machine under load, which requeues, where a planted key parks the task and
  // keeps the worktree as evidence. Same refusal, two treatments (BP-516 review).
  it("refuses when the config cannot be read at all, rather than reading that as clean", async () => {
    const { runner, run } = runnerFor({ code: 128, stderr: "fatal: not a git repository" });
    await expect(commitAll(runner, gitPath, "/wt", "m", IDENTITY)).rejects.toThrow(
      /refusing to stage.*could not be read/
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not call that a tampered checkout, which would park the task", async () => {
    const { runner } = runnerFor({ code: 128, stderr: "fatal: not a git repository" });

    await expect(commitAll(runner, gitPath, "/wt", "m", IDENTITY)).rejects.not.toBeInstanceOf(
      TamperedCheckoutError
    );
  });

  // Not "so a Git-LFS checkout still commits" — it does not, and saying so would be the reverse of
  // the truth. A real LFS checkout sets filter.lfs.clean, which is refused here and was already
  // refused by bindRepository's identical scan (repos.ts:196-200), so it never reached a commit
  // before this change either. What must keep working is the inert sibling: `required` is not a
  // program, and refusing it would fail every repository that merely mentions a filter.
  it("lets an inert sibling leaf through", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, { code: 0, stdout: "abc123\n" });
    expect(await commitAll(runner, gitPath, "/wt", "m", IDENTITY)).toBe("abc123");
    expect(callWith(run, "add")).toContain("add");
  });

  it("refuses filter.lfs.clean like any other, which is what bindRepository already did", async () => {
    const { runner } = runnerFor(readableConfig, { code: 0, stdout: local("filter.lfs.clean=git-lfs clean -- %f") });
    await expect(commitAll(runner, gitPath, "/wt", "m", IDENTITY)).rejects.toThrow(/refusing to stage.*filter\.lfs\.clean/);
  });

  // Its own class, and this is what the pipeline branches on: a refusal keeps the worktree and
  // parks the task, where a failed `git add` requeues (BP-506). Stringified into a bare Error, the
  // two were one thing and the tree holding the evidence was the one that got deleted.
  it("throws a refusal that can be told from a git failure", async () => {
    const { runner } = runnerFor(readableConfig, { code: 0, stdout: local("filter.z.clean=/tmp/payload.sh") });

    await expect(commitAll(runner, gitPath, "/wt", "m", IDENTITY)).rejects.toBeInstanceOf(TamperedCheckoutError);
    await expect(commitAll(runnerFor(readableConfig, noPlantedConfig, { code: 1, stderr: "boom" }).runner, gitPath, "/wt", "m", IDENTITY))
      .rejects.not.toBeInstanceOf(TamperedCheckoutError);
  });

  it("carries the finding, so a caller can report the key without parsing a sentence", async () => {
    const { runner } = runnerFor(readableConfig, { code: 0, stdout: local("filter.z.clean=/tmp/payload.sh") });

    await expect(commitAll(runner, gitPath, "/wt", "m", IDENTITY)).rejects.toMatchObject({
      finding: expect.stringContaining("filter.z.clean"),
    });
  });
});

/**
 * BP-516. `localGitEnv` takes `~/.gitconfig` out of every call this module makes, and `user.email`
 * lives there on most machines — so the identity has to travel with the run rather than be read
 * back at the commit, where the agent has already had a chance to write that file.
 */
describe("the commit identity", () => {
  function envOf(run: ReturnType<typeof vi.fn>, subcommand: string): NodeJS.ProcessEnv {
    const call = run.mock.calls.find(([, args]) => (args as string[]).includes(subcommand));
    if (!call) throw new Error(`git ${subcommand} was never run`);
    return (call[2] as { env: NodeJS.ProcessEnv }).env;
  }

  it("neutralises the operator's global config on every call that stages or commits", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, clean);

    await commitAll(runner, gitPath, "/wt", "m", IDENTITY);

    for (const call of run.mock.calls) {
      expect((call[2] as { env: NodeJS.ProcessEnv }).env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    }
  });

  // Committer as well as author: the two are separate identities to git, and only the author's is
  // what a pull request shows. A commit with no committer is refused just as loudly.
  it("supplies the identity it was given, as both author and committer", async () => {
    const { runner, run } = runnerReturning(dirty, clean, clean, clean);

    await commitAll(runner, gitPath, "/wt", "m", IDENTITY);

    expect(envOf(run, "commit")).toMatchObject({
      GIT_AUTHOR_NAME: "Worker",
      GIT_AUTHOR_EMAIL: "worker@example.com",
      GIT_COMMITTER_NAME: "Worker",
      GIT_COMMITTER_EMAIL: "worker@example.com",
    });
  });

  // Asked of git rather than assembled from two `--get`s: with an address configured and no name,
  // git fills the name from the account itself and commits — measured — where reading the keys one
  // at a time finds half an identity and has to invent a rule for it (BP-516 review).
  const CONFIGURED = { code: 0, stdout: "worker@example.com\n" };

  it("takes the identity git says it would use", async () => {
    const { runner } = runnerFor(
      { code: 0, stdout: "Worker <worker@example.com> 1789000000 +0200\n" },
      CONFIGURED,
    );

    expect(await resolveCommitIdentity(runner, gitPath, "/repo")).toEqual({ ok: true, identity: IDENTITY });
  });

  // One question for who, one for whether anybody chose the address — git answers the first with a
  // guess when nothing is configured, and only on a host whose name has a dot in it.
  it("asks git for the whole answer, then whether the address was configured at all", async () => {
    const { runner, run } = runnerFor({ code: 0, stdout: "Worker <worker@example.com> 1 +0000\n" }, CONFIGURED);

    await resolveCommitIdentity(runner, gitPath, "/repo");

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(["var", "GIT_AUTHOR_IDENT"]));
    expect(run.mock.calls[1][1]).toEqual(expect.arrayContaining(["config", "--get", "user.email"]));
  });

  /**
   * The failure CI found and no laptop could: with nothing configured, git builds
   * `<unix user>@<hostname>` and refuses it only when that address has no dot — so the same empty
   * configuration answered "Author identity unknown" here and `runner@fv-az….cloudapp.net` on the
   * GitHub runner, where the worker would have committed under a person who does not exist.
   */
  it("refuses an address git guessed from the hostname, however dotted that hostname is", async () => {
    const { runner } = runnerFor(
      { code: 0, stdout: "runner <runner@fv-az1234.internal.cloudapp.net> 1 +0000\n" },
      { code: 1, stdout: "" },
    );

    const resolved = await resolveCommitIdentity(runner, gitPath, "/repo");

    expect(resolved).toMatchObject({ ok: false });
    expect((resolved as { reason: string }).reason).toContain("fv-az1234");
    expect((resolved as { reason: string }).reason).toContain("git config --global user.email");
  });

  // Read where the commits are made, with the global config still readable: this is the one call
  // in the worker that is *supposed* to see ~/.gitconfig, because that is where the answer is.
  it("reads it with the operator's own config in place", async () => {
    const { runner, run } = runnerFor({ code: 0, stdout: "Worker <w@e> 1 +0000\n" }, CONFIGURED);

    await resolveCommitIdentity(runner, gitPath, "/repo");

    for (const call of run.mock.calls) {
      expect((call[2] as { env: NodeJS.ProcessEnv }).env.GIT_CONFIG_GLOBAL).toBeUndefined();
    }
  });

  // git's own sentence, kept rather than replaced: it says which of the two faults this is, and
  // the two need different repairs — nothing configured, or a config file git will not parse.
  // The whole block, not its last line: on an unconfigured machine git prints ten lines whose
  // middle two are the commands to run, and keeping only the tail threw away the answer while the
  // prose promised it (BP-516 review).
  it.each([
    [
      "nothing is configured",
      '*** Please tell me who you are.\n\n  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"\n\nfatal: unable to auto-detect email address',
    ],
    ["the config cannot be parsed", "fatal: bad config line 4 in file /Users/x/.gitconfig"],
  ])("carries git's whole answer when %s", async (_case, stderr) => {
    const { runner } = runnerFor({ code: 128, stderr });

    const resolved = await resolveCommitIdentity(runner, gitPath, "/repo");

    expect(resolved.ok).toBe(false);
    expect((resolved as { reason: string }).reason).toBe(stderr.trim());
  });

  // git answers, and the answer is half an identity: `user.email = ""` makes `git var` exit 0 with
  // `Name <> …`, and a commit made with GIT_AUTHOR_EMAIL="" lands with no address at all — pushed,
  // in the pull request, merged. Refused here instead (BP-516 review).
  it("refuses an identity git filled only half of", async () => {
    const { runner } = runnerFor({ code: 0, stdout: "The Operator <> 1789000000 +0200\n" }, CONFIGURED);

    expect(await resolveCommitIdentity(runner, gitPath, "/repo")).toMatchObject({ ok: false });
  });

  it("refuses an answer that is not an identity, rather than committing as half of one", async () => {
    const { runner } = runnerFor({ code: 0, stdout: "no angle brackets here\n" }, CONFIGURED);

    expect(await resolveCommitIdentity(runner, gitPath, "/repo")).toMatchObject({ ok: false });
  });
});
