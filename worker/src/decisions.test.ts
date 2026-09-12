import { describe, it, expect, vi } from "vitest";
import { DecisionSettlement } from "./api.js";
import {
  acceptability,
  branchFor,
  createMarkerStore,
  DecisionContext,
  DecisionMarker,
  heldTaskKeys,
  MarkerFs,
  openDecision,
  parseDecisions,
  ServerDecision,
  settleDecisions,
  sha256,
} from "./decisions.js";
import { claimedTask } from "./__fixtures__/task.js";
import { DiffStats } from "./types.js";

function memoryFs(): MarkerFs & { files: Map<string, string>; modes: string[] } {
  const files = new Map<string, string>();
  const modes: string[] = [];
  return {
    files,
    modes,
    mkdir: (path) => modes.push(`mkdir ${path}`),
    writeFile: (path, text) => {
      modes.push(`write ${path}`);
      files.set(path, text);
    },
    readFile: (path) => files.get(path) ?? null,
    remove: (path) => {
      files.delete(path);
    },
    listNames: () => [...files.keys()].map((path) => path.split("/").pop()!),
  };
}

function diff(over: Partial<DiffStats> = {}): DiffStats {
  return {
    changedLines: 4,
    changedFiles: ["package.json", "src/a.ts"],
    patch: "diff --git a/package.json b/package.json\n+  \"x\": 1\n",
    truncated: false,
    headSha: "a".repeat(40),
    symlinks: [],
    ...over,
  };
}

describe("the marker that holds a worktree back from the reaper", () => {
  it("is written under the state directory, named for the task", () => {
    const fs = memoryFs();
    const store = createMarkerStore("/state", fs);
    store.write(marker());

    expect([...fs.files.keys()]).toEqual(["/state/decisions/CP-158.json"]);
    expect(store.read("CP-158")?.commit).toBe("c0ffee");
  });

  it("creates the directory before writing into it", () => {
    const fs = memoryFs();
    createMarkerStore("/state", fs).write(marker());

    expect(fs.modes).toEqual(["mkdir /state/decisions", "write /state/decisions/CP-158.json"]);
  });

  // api.ts refuses a task key that is not a name; this is the second sink where one becomes a path
  it("refuses a task key that would climb out of the directory", () => {
    const store = createMarkerStore("/state", memoryFs());

    expect(() => store.write(marker({ taskKey: "../../etc/cron" }))).toThrow(/refusing/);
    expect(() => store.read("../../etc/cron")).toThrow(/refusing/);
  });

  it("reads a file that is not a marker as nothing rather than throwing", () => {
    const fs = memoryFs();
    fs.files.set("/state/decisions/CP-158.json", "{ not json");

    expect(createMarkerStore("/state", fs).read("CP-158")).toBeNull();
  });

  /**
   * Keyed on the root and not on the project, because `rebind` resolves several projects onto one
   * checkout — so a sibling project's reaping pass shares this root, and filtering by project
   * would let it destroy the very worktree somebody is being asked about.
   */
  it("answers which task keys under a root are held, ignoring another root's", () => {
    const fs = memoryFs();
    const store = createMarkerStore("/state", fs);
    store.write(marker({ taskKey: "CP-1", worktreeRoot: "/wt" }));
    store.write(marker({ taskKey: "CP-2", worktreeRoot: "/elsewhere" }));

    expect([...heldTaskKeys(store, "/wt")]).toEqual(["CP-1"]);
  });
});

function marker(over: Partial<DecisionMarker> = {}): DecisionMarker {
  return {
    taskKey: "CP-158",
    worktreeRoot: "/wt",
    worktreePath: "/wt/CP-158",
    projectId: "CP",
    taskId: "t1",
    commit: "c0ffee",
    baseSha: "base1",
    createdAt: new Date(1000).toISOString(),
    ...over,
  };
}

describe("whether a refused change may be accepted at all", () => {
  it("offers an ordinary protected-path change", () => {
    expect(acceptability(diff())).toEqual({ acceptable: true, unacceptableReason: "" });
  });

  // For a push event GitHub runs the workflow from the pushed ref, so accepting one would run the
  // agent's own version of CI. The one family excluded on purpose.
  it("refuses a change that edits what CI itself does, naming the file", () => {
    const verdict = acceptability(diff({ changedFiles: ["src/a.ts", ".github/workflows/ci.yml"] }));

    expect(verdict.acceptable).toBe(false);
    expect(verdict.unacceptableReason).toContain(".github/workflows/ci.yml");
  });

  it("refuses a composite action too, which no other rule here matches", () => {
    expect(acceptability(diff({ changedFiles: [".github/actions/setup/action.yml"] })).acceptable).toBe(
      false
    );
  });

  /**
   * `DiffStats.truncated` exists and the first draft of this design never consulted it. The record
   * IS the reading surface, so a change too large to show is one nobody can honestly accept.
   */
  it("refuses a change whose patch was cut, because that is not what was shown", () => {
    const verdict = acceptability(diff({ truncated: true }));

    expect(verdict.acceptable).toBe(false);
    expect(verdict.unacceptableReason).toMatch(/not all of it/);
  });
});

describe("opening a decision", () => {
  function deps(over: { createDecision?: ReturnType<typeof vi.fn> } = {}) {
    const fs = memoryFs();
    const markers = createMarkerStore("/state", fs);
    const createDecision = over.createDecision ?? vi.fn().mockResolvedValue(undefined);
    return { fs, markers, api: { createDecision }, scrub: (text: string) => text, createDecision };
  }

  function input(d = diff()) {
    return {
      task: claimedTask(),
      gate: "protected-paths",
      diff: d,
      worktreePath: "/wt/CP-158",
      worktreeRoot: "/wt",
      baseSha: "base1",
    };
  }

  it("records the whole change, not only the files that tripped the gate", async () => {
    const d = deps();
    await openDecision(d, input());

    const [record] = d.createDecision.mock.calls[0];
    expect(record.files).toEqual(["package.json", "src/a.ts"]);
    expect(record.protectedFiles).toEqual(["package.json"]);
  });

  /**
   * `headSha` and not the last commit the run made: `collectDiff` resolved it with
   * `rev-parse --verify HEAD^{commit}` and judged the change against it, so this is the one value
   * for which "the commit named in the record is the change that was judged" is true.
   */
  it("names the commit the diff was actually taken against", async () => {
    const d = deps();
    await openDecision(d, input());

    expect(d.createDecision.mock.calls[0][0].commit).toBe("a".repeat(40));
    expect(d.markers.read("CP-158")?.commit).toBe("a".repeat(40));
  });

  // Redaction is not reproducible from the board's side, and the machine re-derives git's own
  // output at settle time — so the digest has to be over the patch before it was scrubbed.
  it("digests the patch git printed, while storing the redacted copy", async () => {
    const d = { ...deps(), scrub: () => "[redacted]" };
    const createDecision = vi.fn().mockResolvedValue(undefined);
    await openDecision({ ...d, api: { createDecision } }, input());

    const [record] = createDecision.mock.calls[0];
    expect(record.patch).toBe("[redacted]");
    expect(record.patchSha256).toBe(sha256(diff().patch));
  });

  /**
   * A button over a worktree the reaper is free to destroy is worse than no button, so the marker
   * goes first — and if it cannot be written, nothing is offered at all.
   */
  it("aborts the record when the marker cannot be written", async () => {
    const fs = memoryFs();
    fs.writeFile = () => {
      throw new Error("read-only state directory");
    };
    const createDecision = vi.fn();

    await expect(
      openDecision(
        { markers: createMarkerStore("/state", fs), api: { createDecision }, scrub: (t) => t },
        input()
      )
    ).rejects.toThrow(/read-only/);
    expect(createDecision).not.toHaveBeenCalled();
  });

  // Otherwise a failed offer pins a worktree for ever: nothing on the board will ever answer it.
  it("takes the marker back when the record cannot be posted", async () => {
    const d = deps({ createDecision: vi.fn().mockRejectedValue(new Error("500")) });

    await expect(openDecision(d, input())).rejects.toThrow("500");
    expect(d.markers.read("CP-158")).toBeNull();
  });
});

describe("what the server says is waiting on this machine", () => {
  const row = {
    taskId: "t1",
    projectId: "p1",
    taskKey: "CP-158",
    title: "Add a thing",
    commit: "a".repeat(40),
    patchSha256: "b".repeat(64),
    state: "accepted",
    attempts: 1,
  };

  it("reads a well-formed row", () => {
    expect(parseDecisions([row])).toEqual([row]);
  });

  // Two of these values reach git as arguments, so a row missing one is dropped whole rather than
  // defaulted: a decision with an empty commit is a push of nothing, reported as delivered.
  it("drops a row whose commit is not an object id", () => {
    expect(parseDecisions([{ ...row, commit: "--upload-pack=touch /tmp/x" }])).toEqual([]);
    expect(parseDecisions([{ ...row, commit: "" }])).toEqual([]);
  });

  it("drops a row whose task key is not a name this worker can use", () => {
    expect(parseDecisions([{ ...row, taskKey: "../../etc" }])).toEqual([]);
  });

  it("reads anything that is not a list as nothing", () => {
    expect(parseDecisions(undefined)).toEqual([]);
    expect(parseDecisions({ taskId: "t1" })).toEqual([]);
  });
});

describe("acting on a verdict", () => {
  function harness(over: Partial<DecisionContext> = {}) {
    const fs = memoryFs();
    const markers = createMarkerStore("/state", fs);
    markers.write(marker({ commit: "a".repeat(40) }));

    const settled: DecisionSettlement[] = [];
    const push = vi.fn().mockResolvedValue(undefined);
    const openPr = vi.fn().mockResolvedValue("https://github.com/o/r/pull/7");
    const destroyWorktree = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "", timedOut: false });
    const collectDiff = vi.fn().mockResolvedValue(diff());

    const context: DecisionContext = {
      worktreeRoot: "/wt",
      destroyWorktree,
      delivery: { push, openPr },
      runner: { run } as never,
      collectDiff,
      ...over,
    };

    return {
      markers,
      settled,
      push,
      openPr,
      destroyWorktree,
      run,
      collectDiff,
      deps: {
        markers,
        contextFor: async () => context,
        settle: async (settlement: DecisionSettlement) => {
          settled.push(settlement);
        },
        log: vi.fn(),
      },
    };
  }

  function decision(over: Partial<ServerDecision> = {}): ServerDecision {
    return {
      taskId: "t1",
      projectId: "p1",
      taskKey: "CP-158",
      title: "Add a thing",
      commit: "a".repeat(40),
      patchSha256: sha256(diff().patch),
      state: "accepted",
      attempts: 0,
      ...over,
    };
  }

  const LATER = 10_000;

  it("pushes the accepted commit by name and opens a pull request", async () => {
    const h = harness();
    await settleDecisions(h.deps, [decision()], LATER);

    expect(h.push).toHaveBeenCalledWith("/wt/CP-158", "cp-158/worker", "a".repeat(40));
    expect(h.settled).toEqual([
      { taskId: "t1", state: "delivered", prUrl: "https://github.com/o/r/pull/7" },
    ]);
  });

  /**
   * `git push -- <branch>` resolves the branch in the ref store the linked worktree SHARES with
   * the main clone, so `rev-parse HEAD` in this directory is not what would be sent.
   */
  it("reads the branch ref rather than HEAD", async () => {
    const h = harness();
    await settleDecisions(h.deps, [decision()], LATER);

    expect(h.run.mock.calls[0][1]).toContain("refs/heads/cp-158/worker");
    expect(h.run.mock.calls[0][1]).not.toContain("HEAD");
  });

  it("refuses the push when the branch has moved off the accepted commit", async () => {
    const h = harness();
    h.run.mockResolvedValue({ code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "", timedOut: false });

    await settleDecisions(h.deps, [decision()], LATER);

    expect(h.push).not.toHaveBeenCalled();
    expect(h.settled[0]).toMatchObject({ state: "refused" });
    expect(h.settled[0].error).toMatch(/not at the accepted/);
  });

  /**
   * The digest is the half the ref check cannot answer: a repository-local textconv or external
   * diff driver planted since the refusal renders the same commit as something else, which is the
   * change a person did NOT accept.
   */
  it("refuses the push when the change no longer matches what was accepted", async () => {
    const h = harness();
    h.collectDiff.mockResolvedValue(diff({ patch: "something else entirely" }));

    await settleDecisions(h.deps, [decision()], LATER);

    expect(h.push).not.toHaveBeenCalled();
    expect(h.settled[0]).toMatchObject({ state: "refused" });
  });

  it("refuses when this machine no longer holds a worktree for the task", async () => {
    const h = harness();
    h.markers.remove("CP-158");

    await settleDecisions(h.deps, [decision()], LATER);

    expect(h.push).not.toHaveBeenCalled();
    expect(h.settled[0]).toMatchObject({ state: "refused" });
  });

  // failed, not refused: nothing is wrong with the change, and either can be accepted again
  it("reports a push that broke as failed, carrying the reason", async () => {
    const h = harness();
    h.push.mockRejectedValue(new Error("remote hung up"));

    await settleDecisions(h.deps, [decision()], LATER);

    expect(h.settled[0]).toMatchObject({ state: "failed" });
    expect(h.settled[0].error).toMatch(/remote hung up/);
  });

  // Until the pull request exists, this worktree is the only copy of the work
  it("keeps the worktree until the pull request is open, then removes it", async () => {
    const h = harness();
    h.openPr.mockRejectedValue(new Error("gh exploded"));

    await settleDecisions(h.deps, [decision()], LATER);

    expect(h.destroyWorktree).not.toHaveBeenCalled();
    expect(h.markers.read("CP-158")).not.toBeNull();
  });

  it("removes the worktree and the marker once it is delivered", async () => {
    const h = harness();
    await settleDecisions(h.deps, [decision()], LATER);

    expect(h.destroyWorktree).toHaveBeenCalledWith("CP-158");
    expect(h.markers.read("CP-158")).toBeNull();
  });

  it("removes the worktree on a decline and says so, rather than leaving it to be found", async () => {
    const h = harness();
    await settleDecisions(h.deps, [decision({ state: "declined" })], LATER);

    expect(h.destroyWorktree).toHaveBeenCalledWith("CP-158");
    expect(h.push).not.toHaveBeenCalled();
    expect(h.settled).toEqual([{ taskId: "t1", state: "discarded" }]);
  });

  it("leaves a pending decision alone — it is waiting on a person", async () => {
    const h = harness();
    await settleDecisions(h.deps, [decision({ state: "pending" })], LATER);

    expect(h.push).not.toHaveBeenCalled();
    expect(h.destroyWorktree).not.toHaveBeenCalled();
    expect(h.settled).toEqual([]);
    expect(h.markers.read("CP-158")).not.toBeNull();
  });

  // Abandoned by a person, or superseded by a second claim: the record has left the live list, and
  // the worktree it was holding back goes with it
  it("sweeps a marker whose decision is no longer live, and the worktree with it", async () => {
    const h = harness();
    await settleDecisions(h.deps, [], LATER);

    expect(h.destroyWorktree).toHaveBeenCalledWith("CP-158");
    expect(h.markers.read("CP-158")).toBeNull();
  });

  /**
   * `refreshServerState` is floored at 30 seconds, so a run that opened a decision a moment ago is
   * not yet in any list this pass holds. Sweeping on that destroys the worktree the person is
   * about to be asked about.
   */
  it("does not sweep a marker written after the list was fetched", async () => {
    const h = harness();
    h.markers.write(marker({ createdAt: new Date(LATER + 1).toISOString() }));

    await settleDecisions(h.deps, [], LATER);

    expect(h.destroyWorktree).not.toHaveBeenCalled();
    expect(h.markers.read("CP-158")).not.toBeNull();
  });

  it("does nothing for a project this machine no longer serves", async () => {
    const h = harness();
    await settleDecisions(
      { ...h.deps, contextFor: async () => null },
      [decision()],
      LATER
    );

    expect(h.push).not.toHaveBeenCalled();
    expect(h.settled).toEqual([]);
  });
});

describe("the branch a run puts its work on", () => {
  // Recomputed rather than stored on the record and sent back: a server-supplied string reaching
  // `git push` is a force-push to the default branch waiting to happen
  it("is derived from the task key, lower case", () => {
    expect(branchFor("CP-158")).toBe("cp-158/worker");
  });
});
