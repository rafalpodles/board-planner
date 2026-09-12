import { describe, it, expect, vi, beforeEach } from "vitest";
import sift from "sift";
import { ITaskDecision } from "@/types";

const findOneAndUpdate = vi.fn();
const find = vi.fn();
const workerFindById = vi.fn();

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/task", () => ({ Task: { findOneAndUpdate, find } }));
vi.mock("@/models/worker", () => ({ Worker: { findById: workerFindById } }));

const {
  createDecision,
  decisionsForWorker,
  mayDecide,
  recordVerdict,
  settleDecision,
  supersedableStates,
  toApiDecision,
} = await import("./task-decisions");

const WORKER = "6a7c686f70ed274cf658b1b3";
const OWNER = "69a52b0b903d41d473ae02f6";
const OTHER = "6a70afff45d39cd9bc8bb600";

// What the route read and judged; every verdict is pinned to it.
const PIN = { workerId: WORKER, commit: "a".repeat(40) };

function decision(over: Partial<ITaskDecision> = {}): ITaskDecision {
  return {
    gate: "protected-paths",
    files: ["package.json"],
    protectedFiles: ["package.json"],
    patch: "diff --git a/package.json b/package.json",
    patchTruncated: false,
    patchSha256: "b".repeat(64),
    commit: "a".repeat(40),
    workerId: WORKER,
    taskKey: "CP-158",
    title: "Add a thing",
    acceptable: true,
    unacceptableReason: "",
    state: "pending",
    decidedBy: null,
    decidedAt: null,
    prUrl: "",
    error: "",
    attempts: 0,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  } as ITaskDecision;
}

/** What a filter would match, judged by mongo's own semantics rather than by reading it. */
function matches(filter: unknown, doc: Record<string, unknown>): boolean {
  return [doc].filter(sift(filter as never)).length === 1;
}

/**
 * `recordVerdict` chains `.select()` and `.populate()` onto its update — the patch is
 * `select: false` on the schema and `decidedBy` is an ObjectId until somebody populates it — so
 * the mock has to be a thenable query rather than a resolved value.
 */
function chained(value: unknown) {
  const query = {
    select: () => query,
    populate: () => query,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve),
  };
  return query;
}

function lastFilter(): unknown {
  return findOneAndUpdate.mock.calls[findOneAndUpdate.mock.calls.length - 1][0];
}

function lastUpdate(): Record<string, unknown> {
  const update = findOneAndUpdate.mock.calls[findOneAndUpdate.mock.calls.length - 1][1];
  return (update as { $set: Record<string, unknown> }).$set;
}

beforeEach(() => {
  findOneAndUpdate.mockReset();
  find.mockReset();
  workerFindById.mockReset();
  findOneAndUpdate.mockReturnValue(chained({ decision: decision() }));
});

describe("the machine writing a refusal", () => {
  /**
   * The record says "this machine is holding this commit in a worktree", and only a worker that
   * still holds the task can truthfully say it. Filtered on the run, not merely on the task.
   */
  it("writes only against a live run of this worker on that task", async () => {
    await createDecision("t1", WORKER, "run-1", record());

    const filter = lastFilter() as Record<string, unknown>;
    expect(filter["execution.workerId"]).toBe(WORKER);
    expect(filter["execution.runId"]).toBe("run-1");
  });

  it("opens the record pending, with nobody having answered", async () => {
    await createDecision("t1", WORKER, "run-1", record());

    expect(lastUpdate().decision).toMatchObject({
      state: "pending",
      decidedBy: null,
      decidedAt: null,
      prUrl: "",
      attempts: 0,
    });
  });

  // The worker owns the record, never the request: a machine posting someone else's id would
  // otherwise open a decision only that other machine could settle
  it("stamps the worker from the credential, not from the record it was handed", async () => {
    await createDecision("t1", WORKER, "run-1", { ...record(), workerId: OTHER } as never);

    expect((lastUpdate().decision as { workerId: string }).workerId).toBe(WORKER);
  });

  // A retried post after a verdict must not put the question back in front of the person
  it("does not replace a record somebody is already being asked about", async () => {
    await createDecision("t1", WORKER, "run-1", record());
    const filter = lastFilter();

    expect(matches(filter, live({ decision: decision({ state: "pending" }) }))).toBe(false);
    expect(matches(filter, live({ decision: decision({ state: "accepted" }) }))).toBe(false);
  });

  it("leaves room for the next refusal once the last one is settled", async () => {
    await createDecision("t1", WORKER, "run-1", record());
    const filter = lastFilter();

    expect(matches(filter, live({ decision: decision({ state: "delivered" }) }))).toBe(true);
    expect(matches(filter, live({ decision: null }))).toBe(true);
    expect(matches(filter, live({}))).toBe(true);
  });

  it("says so when no live run of this worker holds the task", async () => {
    findOneAndUpdate.mockResolvedValue(null);

    expect(await createDecision("t1", WORKER, "run-1", record())).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

function record() {
  return {
    gate: "protected-paths",
    files: ["package.json"],
    protectedFiles: ["package.json"],
    patch: "diff",
    patchTruncated: false,
    patchSha256: "b".repeat(64),
    commit: "a".repeat(40),
    taskKey: "CP-158",
    title: "Add a thing",
    acceptable: true,
    unacceptableReason: "",
  };
}

function live(over: Record<string, unknown>): Record<string, unknown> {
  return {
    _id: "t1",
    execution: { workerId: WORKER, runId: "run-1" },
    ...over,
  };
}

describe("a person's verdict", () => {
  /**
   * One conditional update, not a read and then a write: "check then write" lets a simultaneous
   * Accept and Decline both through, and the two then race each other on the machine.
   */
  it("is one conditional update filtered on the state it may come from", async () => {
    await recordVerdict("t1", "accept", OWNER, PIN);

    const filter = lastFilter() as Record<string, unknown>;
    expect(filter["decision.state"]).toEqual({ $in: ["pending", "refused", "failed"] });
    expect(lastUpdate()["decision.state"]).toBe("accepted");
  });

  // Declining is a reply to the question, and the question is only asked once
  it("declines only from pending", async () => {
    await recordVerdict("t1", "decline", OWNER, PIN);

    expect((lastFilter() as Record<string, unknown>)["decision.state"]).toEqual({
      $in: ["pending"],
    });
  });

  /**
   * A machine re-imaged, deregistered, disabled or locked never hears the verdict, and that is
   * what makes every stranded case recoverable — including the ones nobody anticipated.
   */
  it("gives up on anything still waiting, including one the machine already answered", async () => {
    await recordVerdict("t1", "abandon", OWNER, PIN);

    expect((lastFilter() as Record<string, unknown>)["decision.state"]).toEqual({
      $in: ["pending", "accepted", "declined", "refused", "failed"],
    });
  });

  /**
   * The route reads the document, resolves the machine's owner and checks `acceptable` — three
   * round trips — and only then writes. `createDecision` replaces any settled record, so a second
   * run finishing inside that window puts a DIFFERENT change under the same task. On the state
   * alone the verdict would land on it: a record this person never read, belonging to another
   * machine, possibly marked unacceptable.
   */
  it.each(["accept", "decline", "abandon"] as const)(
    "pins a %s to the record the caller was shown",
    async (verdict) => {
      await recordVerdict("t1", verdict, OWNER, PIN);

      const filter = lastFilter() as Record<string, unknown>;
      expect(filter["decision.workerId"]).toBe(WORKER);
      expect(filter["decision.commit"]).toBe("a".repeat(40));
    }
  );

  // Restated here because the route's own read of it is a separate round trip
  it("refuses to accept anything the record does not itself mark acceptable", async () => {
    await recordVerdict("t1", "accept", OWNER, PIN);

    expect((lastFilter() as Record<string, unknown>)["decision.acceptable"]).toBe(true);
  });

  // Declining or giving up on a change nobody may accept is exactly what a person should be able
  // to do, so that clause belongs to accept alone
  it.each(["decline", "abandon"] as const)("does not require acceptable to %s", async (verdict) => {
    await recordVerdict("t1", verdict, OWNER, PIN);

    expect(lastFilter()).not.toHaveProperty("decision.acceptable");
  });

  it("records who answered and when", async () => {
    await recordVerdict("t1", "accept", OWNER, PIN);

    expect(String(lastUpdate()["decision.decidedBy"])).toBe(OWNER);
    expect(lastUpdate()["decision.decidedAt"]).toBeInstanceOf(Date);
  });

  // The last attempt's message describes a settlement this verdict has not reached yet; leaving it
  // would have the panel explain a failure that is no longer what is happening
  it("clears the previous settlement's message when it is accepted again", async () => {
    await recordVerdict("t1", "accept", OWNER, PIN);

    expect(lastUpdate()["decision.error"]).toBe("");
    expect(lastUpdate()["decision.attempts"]).toBe(0);
  });

  it("says so when the record has already been answered", async () => {
    findOneAndUpdate.mockReturnValue(chained(null));

    expect(await recordVerdict("t1", "accept", OWNER, PIN)).toMatchObject({ ok: false, status: 409 });
  });
});

describe("the machine settling what came of the verdict", () => {
  it("moves an accepted record only to what the machine may report", async () => {
    await settleDecision("t1", WORKER, "delivered", { prUrl: "https://x/pull/7" });

    const filter = lastFilter() as Record<string, unknown>;
    expect(filter["decision.workerId"]).toBe(WORKER);
    expect(filter["decision.state"]).toEqual({ $in: ["accepted"] });
    expect(lastUpdate()["decision.prUrl"]).toBe("https://x/pull/7");
  });

  it("discards only what was declined", async () => {
    await settleDecision("t1", WORKER, "discarded");

    expect((lastFilter() as Record<string, unknown>)["decision.state"]).toEqual({
      $in: ["declined"],
    });
  });

  /**
   * Everything a person read stays exactly as it was written, which is what makes "you accepted
   * this commit" mean anything afterwards.
   */
  it("touches only the four fields a settlement owns", async () => {
    await settleDecision("t1", WORKER, "failed", { error: "remote hung up", attempts: 2 });

    expect(Object.keys(lastUpdate()).sort()).toEqual([
      "decision.attempts",
      "decision.error",
      "decision.prUrl",
      "decision.state",
    ]);
  });

  it("refuses a state no machine may put a record into", async () => {
    expect(await settleDecision("t1", WORKER, "accepted")).toMatchObject({ ok: false, status: 400 });
    expect(await settleDecision("t1", WORKER, "abandoned")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});

/**
 * Project membership was the first draft's bar, and it is below what this repo already requires to
 * merely PAUSE a machine — while accepting is heavier, since it runs a hostile agent's change
 * under the owner's pinned GitHub identity and against that repository's CI.
 */
describe("who may answer", () => {
  function ownedBy(owner: unknown) {
    workerFindById.mockReturnValue({ select: () => ({ lean: async () => ({ owner }) }) });
  }

  it("lets the machine's owner", async () => {
    ownedBy(OWNER);

    expect(await mayDecide(WORKER, { _id: OWNER, role: "member" })).toBe(true);
  });

  it("lets an instance admin, without reading the machine at all", async () => {
    expect(await mayDecide(WORKER, { _id: OTHER, role: "admin" })).toBe(true);
    expect(workerFindById).not.toHaveBeenCalled();
  });

  it("refuses another member of the same project", async () => {
    ownedBy(OWNER);

    expect(await mayDecide(WORKER, { _id: OTHER, role: "member" })).toBe(false);
  });

  // typeof null is "object", and a machine released from its owner carries null here — a missing
  // owner must never compare equal to a missing user id
  it("refuses everybody on a machine with no owner", async () => {
    ownedBy(null);

    expect(await mayDecide(WORKER, { _id: OTHER, role: "member" })).toBe(false);
    expect(await mayDecide(WORKER, { _id: undefined, role: "member" })).toBe(false);
  });

  it("refuses a worker id that is not one", async () => {
    expect(await mayDecide("not-an-id", { _id: OWNER, role: "member" })).toBe(false);
  });
});

describe("what a reader is shown", () => {
  it("withholds the machine's own bookkeeping", () => {
    const api = toApiDecision(decision()) as unknown as Record<string, unknown>;

    expect(api.patchSha256).toBeUndefined();
    expect(api.attempts).toBeUndefined();
  });

  it("carries the change, the commit and why it is here", () => {
    const api = toApiDecision(decision())!;

    expect(api).toMatchObject({
      gate: "protected-paths",
      commit: "a".repeat(40),
      files: ["package.json"],
      protectedFiles: ["package.json"],
      acceptable: true,
    });
  });

  // The panel says whether anybody is coming back for this
  it("names the machine and when it was last heard from", () => {
    const api = toApiDecision(decision(), {
      name: "e2e-macbook-pro",
      lastSeenAt: new Date("2026-09-01T10:00:00Z"),
    })!;

    expect(api.workerName).toBe("e2e-macbook-pro");
    expect(api.workerLastSeenAt).toBe("2026-09-01T10:00:00.000Z");
  });

  // The screen must not offer a button that answers 403
  it("says the reader may not answer unless it is told otherwise", () => {
    expect(toApiDecision(decision())!.canDecide).toBe(false);
    expect(toApiDecision(decision(), null, true)!.canDecide).toBe(true);
  });

  /**
   * `decidedBy` is stored as an ObjectId and `decidedBy()` answers null for anything without a
   * username, so without a populate the panel can never name the person who accepted — the one
   * fact the audit row exists to preserve. The fixtures here hand it an already-populated user,
   * which is exactly why nothing caught that the readers did not populate it.
   */
  it("names the person only when the caller populated the reference", () => {
    const raw = toApiDecision(decision({ decidedBy: "69a52b0b903d41d473ae02f6" as never }))!;
    expect(raw.decidedBy).toBeNull();

    const populated = toApiDecision(
      decision({ decidedBy: { _id: OWNER, username: "rafal", fullName: "Rafal" } as never })
    )!;
    expect(populated.decidedBy).toEqual({ _id: OWNER, username: "rafal", fullName: "Rafal" });
  });

  it("answers nothing for a task that has never had a change refused", () => {
    expect(toApiDecision(null)).toBeUndefined();
    expect(toApiDecision(undefined)).toBeUndefined();
  });
});

describe("what the machine is told is waiting on it", () => {
  function waiting(rows: unknown[]) {
    find.mockReturnValue({ select: () => ({ lean: async () => rows }) });
  }

  /**
   * Pending records travel too, deliberately: the worker keeps a marker per task to hold its
   * worktree back from the reaper, and seeing a decision leave this list is the only way it learns
   * a marker should be dropped.
   */
  it("asks for everything not settled, including the ones waiting on a person", async () => {
    waiting([]);
    await decisionsForWorker(WORKER);

    expect(find.mock.calls[0][0]).toEqual({
      "decision.workerId": WORKER,
      "decision.state": { $nin: ["delivered", "discarded", "abandoned", "superseded"] },
    });
  });

  it("carries what a settlement needs and nothing else", async () => {
    waiting([{ _id: "t1", project: "p1", decision: decision({ state: "accepted" }) }]);

    expect(await decisionsForWorker(WORKER)).toEqual([
      {
        taskId: "t1",
        projectId: "p1",
        taskKey: "CP-158",
        title: "Add a thing",
        commit: "a".repeat(40),
        patchSha256: "b".repeat(64),
        state: "accepted",
        attempts: 0,
      },
    ]);
  });

  it("drops a row with no decision on it at all", async () => {
    waiting([{ _id: "t1", project: "p1" }]);

    expect(await decisionsForWorker(WORKER)).toEqual([]);
  });
});

/**
 * A change somebody was still being asked about belongs to the run that produced it, and that run
 * is over the moment a new claim lands: the worktree it named is rebuilt by `worktree add -B`, so
 * the commit the record points at stops existing.
 */
describe("what a second claim sweeps away", () => {
  it("names every state that is not settled", () => {
    expect(supersedableStates()).toEqual([
      "pending",
      "accepted",
      "declined",
      "refused",
      "failed",
    ]);
  });
});
