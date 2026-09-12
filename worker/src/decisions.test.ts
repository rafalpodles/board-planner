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
    suppressedDiffs: [],
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
    projectId: "p1",
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
  /**
   * Three ways the contents vanish while `--numstat` goes on listing the path, plus a real binary
   * — indistinguishable from here, and deliberately treated the same: a file listed as changed
   * with its contents missing is one nobody has been shown.
   */
  it("refuses a change whose contents git does not show, naming the file", () => {
    const verdict = acceptability(diff({ suppressedDiffs: ["package.json"] }));

    expect(verdict.acceptable).toBe(false);
    expect(verdict.unacceptableReason).toContain("package.json");
    expect(verdict.unacceptableReason).toMatch(/not been shown/);
  });

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
    expect(d.markers.read("CP-158")).toMatchObject({
      commit: "a".repeat(40),
      // The settlement re-derives the patch against this, and it is stored nowhere else: the
      // server deliberately holds neither the base nor the worktree path
      baseSha: "base1",
      worktreePath: "/wt/CP-158",
      worktreeRoot: "/wt",
      projectId: "CP",
    });
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
    // What the server did with each report. `settle` answering false is the case every branch
    // below has to survive without destroying the only copy of the work.
    let settleLands = true;
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
      settleFails: () => {
        settleLands = false;
      },
      settleLands: () => {
        settleLands = true;
      },
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
          return settleLands;
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

  // A real wall-clock instant: the unbound-marker bound below is measured against Date.now()
  const LATER = Date.now();

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

  // Against the base the run recorded, which is the only thing that makes the digest comparable:
  // a re-derivation against some other base is a different patch and would always differ
  it("re-derives the patch against the base the run recorded", async () => {
    const h = harness();
    await settleDecisions(h.deps, [decision()], LATER);

    expect(h.collectDiff).toHaveBeenCalledWith(expect.anything(), "/wt/CP-158", "base1");
  });

  /**
   * The panel renders this; a settlement that always reported the first attempt would say a
   * machine had tried once when it had tried five times. All three sites that do not deliver,
   * because pinning one leaves the other two free to report zero.
   */
  it("counts the attempt when the push itself broke", async () => {
    const h = harness();
    h.push.mockRejectedValue(new Error("remote hung up"));

    await settleDecisions(h.deps, [decision({ attempts: 2 })], LATER);

    expect(h.settled[0]).toMatchObject({ state: "failed", attempts: 3 });
  });

  it("counts the attempt when the worktree no longer matches", async () => {
    const h = harness();
    h.run.mockResolvedValue({ code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "", timedOut: false });

    await settleDecisions(h.deps, [decision({ attempts: 2 })], LATER);

    expect(h.settled[0]).toMatchObject({ state: "refused", attempts: 3 });
  });

  it("counts the attempt when the worktree is gone altogether", async () => {
    const h = harness();
    h.markers.remove("CP-158");

    await settleDecisions(h.deps, [decision({ attempts: 2 })], LATER);

    expect(h.settled[0]).toMatchObject({ state: "refused", attempts: 3 });
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

  /**
   * BP-381 review. `deps.settle` used to swallow a failure onto the outbox, so the lines after it
   * always ran: the worktree was destroyed, the marker dropped, and the NEXT pass — seeing the
   * server still say `accepted` and no marker — settled `refused`, which landed first and made the
   * real `delivered` a permanent 409. An open pull request the board never named.
   */
  describe("when the board does not take the report", () => {
    it("keeps the worktree and the marker after a delivered settlement is lost", async () => {
      const h = harness();
      h.settleFails();

      await settleDecisions(h.deps, [decision()], LATER);

      expect(h.push).toHaveBeenCalled();
      expect(h.destroyWorktree).not.toHaveBeenCalled();
      expect(h.markers.read("CP-158")).not.toBeNull();
    });

    /**
     * The same harness for both passes, which is the whole claim: what a failed settlement leaves
     * on disk has to be enough for the next one to finish. A second, fresh harness would be
     * asserting that a clean machine works.
     *
     * Idempotent by construction — the same commit to the same branch is "Everything up-to-date",
     * and `openPr` returns the pull request that already exists.
     */
    it("does the whole settlement again on the next pass, from what the first one left", async () => {
      const h = harness();
      h.settleFails();
      await settleDecisions(h.deps, [decision()], LATER);
      expect(h.settled).toHaveLength(1);

      h.settled.length = 0;
      h.settleLands();
      // Past the first backoff. The retry is spaced as well as counted, so a second pass in the
      // same minute is deliberately not one.
      await settleDecisions(h.deps, [decision()], LATER, () => LATER + 61_000);

      expect(h.settled).toEqual([
        { taskId: "t1", state: "delivered", prUrl: "https://github.com/o/r/pull/7" },
      ]);
      expect(h.destroyWorktree).toHaveBeenCalledWith("CP-158");
      expect(h.markers.read("CP-158")).toBeNull();
      // Twice, not once: the second pass redid the push rather than resuming somewhere
      expect(h.push).toHaveBeenCalledTimes(2);
    });

    // The other order deletes the only copy of the work and then finds out the report did not land
    it("does not remove a declined worktree until the board has the answer", async () => {
      const h = harness();
      h.settleFails();

      await settleDecisions(h.deps, [decision({ state: "declined" })], LATER);

      expect(h.settled).toEqual([{ taskId: "t1", state: "discarded" }]);
      expect(h.destroyWorktree).not.toHaveBeenCalled();
      expect(h.markers.read("CP-158")).not.toBeNull();
    });
  });

  /**
   * A task key is unique per project, not per machine, and `rebind` can put two projects on one
   * checkout. `destroyWorktree` resolves against the project the CONTEXT names, so a row naming a
   * sibling project would delete the wrong directory for the same key.
   */
  it("refuses a row whose project is not the one the worktree belongs to", async () => {
    const h = harness();
    await settleDecisions(h.deps, [decision({ projectId: "another-project" })], LATER);

    expect(h.push).not.toHaveBeenCalled();
    expect(h.destroyWorktree).not.toHaveBeenCalled();
    expect(h.markers.read("CP-158")).not.toBeNull();
    // Settled, not skipped: skipping leaves the record live for ever, answered by nothing and
    // logged on every poll
    expect(h.settled[0]).toMatchObject({ state: "refused", attempts: 1 });
    expect(h.settled[0].error).toMatch(/another project/);
  });

  /**
   * Dropping the outbox took away a ceiling as well as a hazard: an accepted decision that keeps
   * failing is retried WHOLE every poll — collectDiff, a push and a `gh pr create` — and the
   * server's state never changes, so nothing ends it.
   */
  /**
   * Counted on this machine's own disk rather than read off the record. The record's `attempts`
   * only advances when a settlement LANDS, so a board that will not take the report leaves it
   * where it was while every pass goes on spending a push and a `gh pr create` — the runaway, and
   * the one case that counter could not see.
   */
  it("stops after five tries rather than spending a settlement every poll for ever", async () => {
    const h = harness();
    h.markers.write(marker({ commit: "a".repeat(40), attempts: 5 }));

    await settleDecisions(h.deps, [decision()], LATER);

    expect(h.push).not.toHaveBeenCalled();
    expect(h.collectDiff).not.toHaveBeenCalled();
    expect(h.settled[0]).toMatchObject({ state: "failed" });
    expect(h.settled[0].error).toMatch(/tried 5 times/);
  });

  // A pause, not a verdict: accepting again resets the count, and the count is what this reads
  it("has another go once somebody has accepted it again", async () => {
    const h = harness();

    await settleDecisions(h.deps, [decision({ attempts: 0 })], LATER);

    expect(h.push).toHaveBeenCalled();
  });

  // `failed` is unreachable from `declined`, so the ceiling has to settle from the state it is in
  it("discards rather than failing when the exhausted row was a decline", async () => {
    const h = harness();
    h.markers.write(marker({ commit: "a".repeat(40), attempts: 5 }));

    await settleDecisions(h.deps, [decision({ state: "declined" })], LATER);

    expect(h.settled[0]).toMatchObject({ state: "discarded" });
  });

  // `refused` is reachable only from `accepted`, so reporting it for a declined row is a 409 on
  // every pass — the same never-ending loop, with a write attached
  it("discards a declined row whose marker belongs to another project", async () => {
    const h = harness();

    await settleDecisions(
      h.deps,
      [decision({ state: "declined", projectId: "another-project" })],
      LATER
    );

    expect(h.settled[0]).toEqual({ taskId: "t1", state: "discarded" });
    expect(h.destroyWorktree).not.toHaveBeenCalled();
    // `discarded` has no error field, so the reason lives only in the log
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("another-project"));
  });

  // The fourth site, and the one D6 left out when it pinned the other three
  it("counts the attempt on a project mismatch too", async () => {
    const h = harness();
    await settleDecisions(
      h.deps,
      [decision({ projectId: "another-project", attempts: 4 })],
      LATER
    );

    expect(h.settled[0]).toMatchObject({ attempts: 5 });
  });

  /**
   * Nothing is acted on, and nothing is reported: without a binding there is no worktree to push
   * from and no remote to push to. The marker stays because `sweepMarkers` only reaches a decision
   * that has LEFT the live list — this one has not.
   */
  it("does nothing for a project this machine no longer serves", async () => {
    const h = harness();
    await settleDecisions(
      { ...h.deps, contextFor: async () => null },
      [decision()],
      LATER
    );

    expect(h.push).not.toHaveBeenCalled();
    expect(h.settled).toEqual([]);
    expect(h.markers.read("CP-158")).not.toBeNull();
  });

  /**
   * Kept, but not for ever: the decision is settled, nothing will ever answer it, and
   * `heldTaskKeys` would otherwise exempt that directory from every future pass — including a
   * sibling project's that shares the root.
   */
  it("lets an unbound project's hold go once the assignment plainly is not coming back", async () => {
    const h = harness();
    const log = vi.fn();
    h.markers.write(marker({ createdAt: new Date(LATER - 8 * 24 * 60 * 60_000).toISOString() }));

    await settleDecisions({ ...h.deps, contextFor: async () => null, log }, [], LATER);

    expect(h.markers.read("CP-158")).toBeNull();
    // And says where the directory it stopped holding is, because that is now a person's to remove
    expect(log).toHaveBeenCalledWith(expect.stringContaining("/wt/CP-158"));
  });

  it("keeps holding one that is merely a few days old", async () => {
    const h = harness();
    h.markers.write(marker({ createdAt: new Date(LATER - 2 * 24 * 60 * 60_000).toISOString() }));

    await settleDecisions({ ...h.deps, contextFor: async () => null }, [], LATER);

    expect(h.markers.read("CP-158")).not.toBeNull();
  });
});

describe("the branch a run puts its work on", () => {
  // Recomputed rather than stored on the record and sent back: a server-supplied string reaching
  // `git push` is a force-push to the default branch waiting to happen
  it("is derived from the task key, lower case", () => {
    expect(branchFor("CP-158")).toBe("cp-158/worker");
  });
});

/**
 * Five tries against a thirty-second refresh floor is a two-and-a-half-minute budget, which an
 * ordinary redeploy eats whole — and the record would then say a machine gave up when what
 * happened is that the board restarted.
 */
describe("how the retries are spaced", () => {
  function harnessWithMarker(over: Partial<DecisionMarker> = {}) {
    const fs = memoryFs();
    const markers = createMarkerStore("/state", fs);
    markers.write(marker({ commit: "a".repeat(40), ...over }));
    const push = vi.fn().mockResolvedValue(undefined);
    const settled: DecisionSettlement[] = [];
    return {
      markers,
      push,
      settled,
      deps: {
        markers,
        contextFor: async () => ({
          worktreeRoot: "/wt",
          destroyWorktree: vi.fn().mockResolvedValue(undefined),
          delivery: { push, openPr: vi.fn().mockResolvedValue("https://x/pull/1") },
          runner: {
            run: vi.fn().mockResolvedValue({
              code: 0,
              stdout: `${"a".repeat(40)}\n`,
              stderr: "",
              timedOut: false,
            }),
          } as never,
          collectDiff: vi.fn().mockResolvedValue(diff()),
        }),
        settle: async (settlement: DecisionSettlement) => {
          settled.push(settlement);
          return false;
        },
        log: vi.fn(),
      },
    };
  }

  const NOW = Date.parse("2026-09-01T12:00:00.000Z");

  function row(): ServerDecision {
    return {
      taskId: "t1",
      projectId: "p1",
      taskKey: "CP-158",
      title: "Add a thing",
      commit: "a".repeat(40),
      patchSha256: sha256(diff().patch),
      state: "accepted",
      attempts: 0,
    };
  }

  it("does not try again in the same minute", async () => {
    const h = harnessWithMarker({ attempts: 1, lastAttemptAt: new Date(NOW - 30_000).toISOString() });

    await settleDecisions(h.deps, [row()], NOW, () => NOW);

    expect(h.push).not.toHaveBeenCalled();
  });

  it("tries again once the wait has passed", async () => {
    const h = harnessWithMarker({ attempts: 1, lastAttemptAt: new Date(NOW - 61_000).toISOString() });

    await settleDecisions(h.deps, [row()], NOW, () => NOW);

    expect(h.push).toHaveBeenCalled();
  });

  // Doubling, so five attempts span half an hour rather than two minutes
  it("waits longer after each failure", async () => {
    const h = harnessWithMarker({ attempts: 4, lastAttemptAt: new Date(NOW - 7 * 60_000).toISOString() });

    await settleDecisions(h.deps, [row()], NOW, () => NOW);

    expect(h.push).not.toHaveBeenCalled();
  });

  // Counted before the spending, so a pass that never reports anything still counts
  it("counts the attempt before it spends anything", async () => {
    const h = harnessWithMarker();

    await settleDecisions(h.deps, [row()], NOW, () => NOW);

    expect(h.markers.read("CP-158")?.attempts).toBe(1);
    expect(h.settled[0]).toMatchObject({ state: "delivered" });
  });
});
