import { describe, it, expect, vi } from "vitest";
import { createDelivery } from "./delivery.js";
import { CommandResult } from "./exec.js";
import { ClaimedTask } from "./types.js";

const task: ClaimedTask = {
  taskId: "t1",
  taskKey: "CP-158",
  taskNumber: 158,
  title: "Add a thing",
  description: "",
  acceptanceCriteria: [],
  attempts: 1,
};

const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false };

// Drops the "-c key=value" pairs delivery.ts prepends to git commands, so a response keyed by
// "git push" still matches regardless of which config flags ride along in front of it.
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

function argsOf(run: ReturnType<typeof vi.fn>, index = 0): string[] {
  return run.mock.calls[index][1] as string[];
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
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.pager=cat",
        "push",
        "--force-with-lease",
        "-u",
        "origin",
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
    const run = vi.fn().mockResolvedValue({ code: -1, stdout: "", stderr: "", timedOut: true });
    await expect(createDelivery({ run }).push("/wt", "cp-158/worker")).rejects.toThrow(/timed out/);
  });

  // The repository was approved by bindRepository, but its own gitconfig (credential.helper,
  // core.sshCommand, ...) still fires on this call unless it is neutralised here too
  it("neutralises system and repository git config on the push", async () => {
    const run = vi.fn().mockResolvedValue(ok);
    await createDelivery({ run }).push("/wt", "cp-158/worker");

    const [command, args, opts] = run.mock.calls[0];
    expect(command).toBe("git");
    expect(args).toEqual(expect.arrayContaining(["-c", "core.pager=cat"]));
    expect((opts as { env: Record<string, string> }).env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });
});

describe("openPr", () => {
  // gh does not understand git's -c flag, so only git invocations may carry it
  it("does not prepend git config flags to a gh command", async () => {
    const run = vi.fn().mockResolvedValue({ ...ok, stdout: "https://github.com/x/y/pull/7" });
    await createDelivery({ run }).openPr("/wt", task, "summary");

    const [command, args] = run.mock.calls[0];
    expect(command).toBe("gh");
    expect(args).not.toContain("-c");
  });

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
