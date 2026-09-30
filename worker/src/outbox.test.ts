import { describe, it, expect, vi } from "vitest";
import { ApiClient, ApiError } from "./api.js";
import { createOutbox, NOT_ASSIGNED, Store } from "./outbox.js";

function memoryStore(initial = ""): Store & { text: string } {
  return {
    text: initial,
    read() {
      return this.text;
    },
    write(text: string) {
      this.text = text;
    },
  };
}

function apiSpy(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    claim: vi.fn(),
    statusIds: vi.fn(),
    boardColumns: vi.fn(),
    comment: vi.fn<ApiClient["comment"]>().mockResolvedValue(undefined),
    setStatus: vi.fn<ApiClient["setStatus"]>().mockResolvedValue(undefined),
    release: vi.fn<ApiClient["release"]>().mockResolvedValue(undefined),
    ...overrides,
  } as ApiClient;
}

describe("createOutbox", () => {
  it("delivers what it holds and empties itself", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });
    outbox.add({ kind: "status", projectId: "CP", taskId: "t1", status: "done" });
    const api = apiSpy();

    expect(await outbox.flush(api)).toEqual({ delivered: 2, pending: 0, dropped: 0 });
    expect(api.comment).toHaveBeenCalledWith("CP", "t1", "merged");
    expect(api.setStatus).toHaveBeenCalledWith("CP", "t1", "done");
    expect(outbox.pending()).toBe(0);
  });

  // The whole reason this exists: the process can die between the merge and the report
  it("survives a restart, because a new instance reads the same store", async () => {
    const store = memoryStore();
    createOutbox(store, vi.fn()).add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });

    const afterRestart = createOutbox(store, vi.fn());

    expect(afterRestart.pending()).toBe(1);
    expect(await afterRestart.flush(apiSpy())).toMatchObject({ delivered: 1 });
  });

  it("keeps an undelivered report and counts the attempt", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });
    const api = apiSpy({ comment: vi.fn().mockRejectedValue(new Error("502")) });

    expect(await outbox.flush(api)).toEqual({ delivered: 0, pending: 1, dropped: 0 });
    expect(outbox.pending()).toBe(1);
  });

  // A status move that lands before its comment reads as a decision with no reason given
  it("holds back the rest of a task's reports at its first failure rather than reordering around it", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });
    outbox.add({ kind: "status", projectId: "CP", taskId: "t1", status: "done" });
    const api = apiSpy({ comment: vi.fn().mockRejectedValue(new Error("502")) });

    const result = await outbox.flush(api);

    expect(result).toEqual({ delivered: 0, pending: 2, dropped: 0 });
    expect(api.setStatus).not.toHaveBeenCalled();
  });

  // BP-797. What a failure holds back is what its answer names, and nothing it does not.
  describe("what a failure holds back", () => {
    const refusal = (status: number, error: string) =>
      new ApiError(`POST failed: ${status}`, status, JSON.stringify({ error }));
    const notAssigned = () => refusal(403, NOT_ASSIGNED);
    const heldByAnotherRun = () => refusal(409, "held");
    const attemptsIn = (store: { text: string }) =>
      store.text
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { op: { taskId: string }; attempts: number }))
        .map((entry) => `${entry.op.taskId}:${entry.attempts}`);

    // A redeploy after a merge fails every request for minutes. Charging each task's oldest report
    // for it would drop one per task — the comment, so the status lands without its reason.
    it.each([
      ["a network failure", () => new TypeError("fetch failed")],
      ["a 503", () => new ApiError("POST failed: 503", 503, "")],
      ["a machine-wide 403", () => refusal(403, "this worker may not run")],
      ["a 403 it does not recognise", () => refusal(403, "no")],
    ])("charges an outage of %s to the first report only", async (_what, failure) => {
      const store = memoryStore();
      const outbox = createOutbox(store, vi.fn());
      for (const taskId of ["a", "b", "c"]) {
        outbox.add({ kind: "comment", projectId: `P-${taskId}`, taskId, body: "why" });
        outbox.add({ kind: "status", projectId: `P-${taskId}`, taskId, status: "done" });
      }
      const api = apiSpy({
        comment: vi.fn().mockRejectedValue(failure()),
        setStatus: vi.fn().mockRejectedValue(failure()),
      });

      let dropped = 0;
      for (let i = 0; i < 20; i += 1) dropped += (await outbox.flush(api)).dropped;

      expect(dropped).toBe(1);
      expect(attemptsIn(store)).toEqual(["a:1", "b:0", "b:0", "c:0", "c:0"]);
      expect(api.comment).toHaveBeenCalledTimes(20);
    });

    it("lets another project's reports through a project that paused this machine", async () => {
      const store = memoryStore();
      const outbox = createOutbox(store, vi.fn());
      outbox.add({ kind: "comment", projectId: "P1", taskId: "a", body: "paused project" });
      outbox.add({ kind: "comment", projectId: "P1", taskId: "c", body: "same project" });
      outbox.add({ kind: "comment", projectId: "P2", taskId: "b", body: "merged" });
      outbox.add({ kind: "status", projectId: "P2", taskId: "b", status: "done" });
      const comment = vi.fn<ApiClient["comment"]>(async (project) => {
        if (project === "P1") throw notAssigned();
      });
      const api = apiSpy({ comment });

      expect(await outbox.flush(api)).toEqual({ delivered: 2, pending: 2, dropped: 0 });
      expect(comment).toHaveBeenCalledWith("P2", "b", "merged");
      expect(api.setStatus).toHaveBeenCalledWith("P2", "b", "done");
      expect(comment).not.toHaveBeenCalledWith("P1", "c", "same project");
      expect(attemptsIn(store)).toEqual(["a:1", "c:0"]);
    });

    it("holds only the task another run holds, not its project", async () => {
      const store = memoryStore();
      const outbox = createOutbox(store, vi.fn());
      outbox.add({ kind: "status", projectId: "P1", taskId: "a", status: "done" });
      outbox.add({ kind: "comment", projectId: "P1", taskId: "a", body: "after" });
      outbox.add({ kind: "comment", projectId: "P1", taskId: "c", body: "sibling" });
      const api = apiSpy({ setStatus: vi.fn().mockRejectedValue(heldByAnotherRun()) });

      expect(await outbox.flush(api)).toEqual({ delivered: 1, pending: 2, dropped: 0 });
      expect(api.comment).toHaveBeenCalledTimes(1);
      expect(api.comment).toHaveBeenCalledWith("P1", "c", "sibling");
    });

    it("keeps a held task's own reports in order behind its failure, across flushes", async () => {
      const store = memoryStore();
      const outbox = createOutbox(store, vi.fn());
      outbox.add({ kind: "comment", projectId: "P1", taskId: "a", body: "why" });
      outbox.add({ kind: "comment", projectId: "P2", taskId: "b", body: "other" });
      outbox.add({ kind: "status", projectId: "P1", taskId: "a", status: "review" });
      const refusing = apiSpy({
        comment: vi.fn<ApiClient["comment"]>(async (_project, taskId) => {
          if (taskId === "a") throw heldByAnotherRun();
        }),
      });

      expect(await outbox.flush(refusing)).toEqual({ delivered: 1, pending: 2, dropped: 0 });
      expect(refusing.setStatus).not.toHaveBeenCalled();

      const calls: string[] = [];
      const healed = apiSpy({
        comment: vi.fn<ApiClient["comment"]>(async (_project, taskId, body) => {
          calls.push(`comment ${taskId} ${body}`);
        }),
        setStatus: vi.fn<ApiClient["setStatus"]>(async (_project, taskId, status) => {
          calls.push(`status ${taskId} ${status}`);
        }),
      });

      expect(await outbox.flush(healed)).toEqual({ delivered: 2, pending: 0, dropped: 0 });
      expect(calls).toEqual(["comment a why", "status a review"]);
    });

    const recordFor = (taskId: string) => ({
      taskId,
      runId: `run-${taskId}`,
      taskKey: `CP-${taskId}`,
      agentId: "a1",
      agentName: "Default",
      outcome: "merged",
      refusedBy: "",
      detail: "",
      startedAt: "2026-09-30T00:00:00.000Z",
      finishedAt: "2026-09-30T00:01:00.000Z",
      costUsd: 0.5,
    });

    it("sends another task's run record while one task is held", async () => {
      const outbox = createOutbox(memoryStore(), vi.fn());
      outbox.add({ kind: "comment", projectId: "P1", taskId: "a", body: "why" });
      outbox.add({ kind: "run", projectId: "P1", record: recordFor("b") });
      const postRun = vi.fn<ApiClient["postRun"]>().mockResolvedValue(undefined);
      const api = apiSpy({ comment: vi.fn().mockRejectedValue(heldByAnotherRun()), postRun });

      expect(await outbox.flush(api)).toEqual({ delivered: 1, pending: 1, dropped: 0 });
      expect(postRun).toHaveBeenCalledWith("P1", expect.objectContaining({ taskId: "b" }));
    });

    it("holds only its own task behind a run record that fails", async () => {
      const outbox = createOutbox(memoryStore(), vi.fn());
      outbox.add({ kind: "run", projectId: "P1", record: recordFor("a") });
      outbox.add({ kind: "status", projectId: "P1", taskId: "a", status: "done" });
      outbox.add({ kind: "comment", projectId: "P1", taskId: "b", body: "other" });
      const api = apiSpy({ postRun: vi.fn().mockRejectedValue(heldByAnotherRun()) });

      expect(await outbox.flush(api)).toEqual({ delivered: 1, pending: 2, dropped: 0 });
      expect(api.setStatus).not.toHaveBeenCalled();
      expect(api.comment).toHaveBeenCalledWith("P1", "b", "other");
    });

    it("holds everything behind a failing line that names no task, since it cannot be placed", async () => {
      const orphan = JSON.stringify({ op: { kind: "run", projectId: "P1" }, attempts: 0 });
      const later = JSON.stringify({
        op: { kind: "comment", projectId: "P2", taskId: "b", body: "merged" },
        attempts: 0,
      });
      const outbox = createOutbox(memoryStore(`${orphan}\n${later}\n`), vi.fn());
      const api = apiSpy({ postRun: vi.fn().mockRejectedValue(heldByAnotherRun()) });

      expect(await outbox.flush(api)).toEqual({ delivered: 0, pending: 2, dropped: 0 });
      expect(api.comment).not.toHaveBeenCalled();
    });

    it("sends a line that names no task past another project's hold", async () => {
      const held = JSON.stringify({
        op: { kind: "comment", projectId: "P1", taskId: "a", body: "why" },
        attempts: 0,
      });
      const orphan = JSON.stringify({ op: { kind: "run", projectId: "P2" }, attempts: 0 });
      const outbox = createOutbox(memoryStore(`${held}\n${orphan}\n`), vi.fn());
      const api = apiSpy({
        comment: vi.fn().mockRejectedValue(notAssigned()),
        postRun: vi.fn().mockResolvedValue(undefined),
      });

      expect(await outbox.flush(api)).toEqual({ delivered: 1, pending: 1, dropped: 0 });
      expect(api.postRun).toHaveBeenCalledTimes(1);
    });

    it("keeps a line that names no task behind a task already held, which it may belong to", async () => {
      const held = JSON.stringify({
        op: { kind: "comment", projectId: "P1", taskId: "a", body: "why" },
        attempts: 0,
      });
      const orphan = JSON.stringify({ op: { kind: "run", projectId: "P2" }, attempts: 0 });
      const outbox = createOutbox(memoryStore(`${held}\n${orphan}\n`), vi.fn());
      const api = apiSpy({
        comment: vi.fn().mockRejectedValue(heldByAnotherRun()),
        postRun: vi.fn().mockResolvedValue(undefined),
      });

      expect(await outbox.flush(api)).toEqual({ delivered: 0, pending: 2, dropped: 0 });
      expect(api.postRun).not.toHaveBeenCalled();
    });
  });

  it("delivers on a later flush once the server comes back", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });
    await outbox.flush(apiSpy({ comment: vi.fn().mockRejectedValue(new Error("502")) }));

    const api = apiSpy();
    expect(await outbox.flush(api)).toEqual({ delivered: 1, pending: 0, dropped: 0 });
    expect(api.comment).toHaveBeenCalledWith("CP", "t1", "merged");
  });

  // Otherwise one permanently rejected report blocks every later one forever
  it("gives up on a report the server will never accept", async () => {
    const store = memoryStore();
    const log = vi.fn();
    const outbox = createOutbox(store, log);
    outbox.add({ kind: "comment", projectId: "CP", taskId: "gone", body: "merged" });
    const api = apiSpy({ comment: vi.fn().mockRejectedValue(new Error("404")) });

    for (let i = 0; i < 19; i += 1) await outbox.flush(api);
    expect(outbox.pending()).toBe(1);

    expect(await outbox.flush(api)).toEqual({ delivered: 0, pending: 0, dropped: 1 });
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/giving up/);
  });

  /**
   * BP-613. A 4xx is the server having read the request and refused it, so the twenty-first
   * attempt is the first one identical to the first — and every later report waits behind it for
   * the ten minutes that takes. A worker newer than its board produces one of these per poll.
   */
  it("drops a refusal the board will only refuse again, on its first flush", async () => {
    const store = memoryStore();
    const log = vi.fn();
    const outbox = createOutbox(store, log);
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });
    const api = apiSpy({
      comment: vi.fn().mockRejectedValue(new ApiError("POST failed: 400", 400, "Unknown outcome")),
    });

    expect(await outbox.flush(api)).toEqual({ delivered: 0, pending: 0, dropped: 1 });
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/refused it and will refuse it again/);
  });

  it.each([400, 405, 413, 422])("drops a %i, which the board will refuse in the same words for ever", async (status) => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });
    const api = apiSpy({
      comment: vi.fn().mockRejectedValue(new ApiError(`POST failed: ${status}`, status, "no")),
    });

    expect(await outbox.flush(api)).toEqual({ delivered: 0, pending: 0, dropped: 1 });
  });

  it("does not hold a later report behind one the board refused", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "refused" });
    outbox.add({ kind: "status", projectId: "CP", taskId: "t2", status: "done" });
    const api = apiSpy({
      comment: vi.fn().mockRejectedValue(new ApiError("POST failed: 400", 400, "no")),
    });

    expect(await outbox.flush(api)).toEqual({ delivered: 1, pending: 0, dropped: 1 });
    expect(api.setStatus).toHaveBeenCalledWith("CP", "t2", "done");
  });

  /**
   * The answers that look permanent and are not, each one a state the board leaves within minutes:
   * a rotated credential (401), a grant being edited (403), and a task another run holds — which is
   * what an expired lease being reclaimed looks like (409, `task-service.ts`). Dropping one of
   * these destroys the post-merge report, which is the thing this module exists to keep.
   */
  // Everything that is not a permanent refusal: the two a server sends to mean "ask again" (408,
  // 429), the 5xx it sends to mean "not now", and the four 4xx the board can retract — 401 a token
  // being renewed, 403 a grant arriving, 404 the edge during a redeploy, 409 another run's hold
  // clearing. The control for the rule above, which lists the refusals that are final.
  it.each([401, 403, 404, 409, 408, 429, 500, 502, 503])("keeps retrying a %i", async (status) => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });
    const api = apiSpy({
      comment: vi.fn().mockRejectedValue(new ApiError(`POST failed: ${status}`, status, "later")),
    });

    expect(await outbox.flush(api)).toEqual({ delivered: 0, pending: 1, dropped: 0 });
  });

  // BP-758 changed no rule here. These pin the two answers the board now gives a run record, a 403
  // for a pause and a 422 for a run that is not this machine's, against the rule that handles them.
  describe("a run record", () => {
    const record = {
      taskId: "t1",
      runId: "run-1",
      taskKey: "CP-1",
      agentId: "a1",
      agentName: "Default",
      outcome: "merged",
      refusedBy: "",
      detail: "",
      startedAt: "2026-09-30T00:00:00.000Z",
      finishedAt: "2026-09-30T00:01:00.000Z",
      costUsd: 0.5,
    };

    it("keeps it through a 403, which a paused machine gets (characterises the existing rule)", async () => {
      const outbox = createOutbox(memoryStore(), vi.fn());
      outbox.add({ kind: "run", projectId: "CP", record });
      const api = apiSpy({
        postRun: vi.fn().mockRejectedValue(new ApiError("POST failed: 403", 403, "this worker may not run")),
      });

      expect(await outbox.flush(api)).toEqual({ delivered: 0, pending: 1, dropped: 0 });
    });

    it("drops it on the 422 the board now answers for another machine's run, holding nothing up (characterises the existing rule)", async () => {
      const outbox = createOutbox(memoryStore(), vi.fn());
      outbox.add({ kind: "run", projectId: "CP", record });
      outbox.add({ kind: "comment", projectId: "CP", taskId: "t2", body: "next" });
      const api = apiSpy({
        postRun: vi
          .fn()
          .mockRejectedValue(
            new ApiError("POST failed: 422", 422, "That run is not this machine's to record")
          ),
      });

      expect(await outbox.flush(api)).toEqual({ delivered: 1, pending: 0, dropped: 1 });
      expect(api.comment).toHaveBeenCalledWith("CP", "t2", "next");
    });

    it("sends it with the run it names", async () => {
      const outbox = createOutbox(memoryStore(), vi.fn());
      outbox.add({ kind: "run", projectId: "CP", record });
      const postRun = vi.fn<ApiClient["postRun"]>().mockResolvedValue(undefined);

      await outbox.flush(apiSpy({ postRun }));

      expect(postRun).toHaveBeenCalledWith("CP", expect.objectContaining({ runId: "run-1" }));
    });
  });

  // A failure with no status at all — a socket that never connected — is a transient, and the
  // twenty attempts are what it has always had.
  it("keeps retrying a failure that never reached the server", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "comment", projectId: "CP", taskId: "t1", body: "merged" });
    const api = apiSpy({ comment: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) });

    expect(await outbox.flush(api)).toEqual({ delivered: 0, pending: 1, dropped: 0 });
  });

  it("carries the refund flag, so a requeue does not silently become a refund", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "release", projectId: "CP", taskId: "t1", refund: false });
    const api = apiSpy();

    await outbox.flush(api);

    expect(api.release).toHaveBeenCalledWith("CP", "t1", { refund: false });
  });

  it("releases with a refund when that is what was queued", async () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    outbox.add({ kind: "release", projectId: "CP", taskId: "t1", refund: true });
    const api = apiSpy();

    await outbox.flush(api);

    expect(api.release).toHaveBeenCalledWith("CP", "t1");
  });

  it("ignores a corrupted line rather than losing the whole queue", async () => {
    const good = JSON.stringify({
      op: { kind: "comment", projectId: "CP", taskId: "t1", body: "ok" },
      attempts: 0,
    });
    const store = memoryStore(`not json\n${good}\n{"op":{}}\n`);

    expect(createOutbox(store, vi.fn()).pending()).toBe(1);
  });

  it("treats an unreadable store as empty instead of throwing into the run loop", async () => {
    const store: Store = {
      read() {
        throw new Error("no such file");
      },
      write: vi.fn(),
    };

    expect(createOutbox(store, vi.fn()).pending()).toBe(0);
  });

  it("keeps the newest reports when the queue is capped", () => {
    const store = memoryStore();
    const outbox = createOutbox(store, vi.fn());
    for (let i = 0; i < 505; i += 1) {
      outbox.add({ kind: "comment", projectId: "CP", taskId: `t${i}`, body: "x" });
    }

    expect(outbox.pending()).toBe(500);
    expect(store.text).toContain('"t504"');
    expect(store.text).not.toContain('"t0"');
  });
});
