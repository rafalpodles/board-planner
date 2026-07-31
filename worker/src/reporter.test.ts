import { describe, it, expect, vi } from "vitest";
import { StatusIds } from "./api.js";
import { createReporter } from "./reporter.js";
import { ClaimedTask } from "./types.js";

const task: ClaimedTask = {
  taskId: "t1",
  taskKey: "CP-158",
  taskNumber: 158,
  title: "Add a thing",
  description: "body",
  acceptanceCriteria: [],
  attempts: 1,
};

// Deliberately none of the seeded ids, so any surviving literal fails
const statuses: StatusIds = { approved: "ready", review: "checking", done: "shipped" };

function apiSpy() {
  return {
    claim: vi.fn(),
    setStatus: vi.fn<(taskId: string, status: string) => Promise<void>>().mockResolvedValue(undefined),
    comment: vi.fn<(taskId: string, body: string) => Promise<void>>().mockResolvedValue(undefined),
    release: vi.fn<(taskId: string) => Promise<void>>().mockResolvedValue(undefined),
    statusIds: vi.fn<() => Promise<StatusIds>>().mockResolvedValue(statuses),
  };
}

describe("createReporter", () => {
  it("routes a blocked task to the board's review column with the reason", async () => {
    const api = apiSpy();
    await createReporter(api, statuses).blocked(task, "requirements are ambiguous");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "checking");
    expect(api.comment.mock.calls[0][1]).toMatch(/requirements are ambiguous/);
  });

  it("names the gate and the pushed branch when a gate rejects", async () => {
    const api = apiSpy();
    await createReporter(api, statuses).gateRejected(task, "diff-size", "diff is 900 lines, limit is 400", "cp-158/worker");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "checking");
    expect(api.comment.mock.calls[0][1]).toMatch(/diff-size/);
    expect(api.comment.mock.calls[0][1]).toMatch(/900 lines/);
    expect(api.comment.mock.calls[0][1]).toMatch(/cp-158\/worker/);
  });

  it("releases through the release endpoint so the attempt is given back", async () => {
    const api = apiSpy();
    await createReporter(api, statuses).released(task, "usage limit reached");

    expect(api.release).toHaveBeenCalledWith("t1");
    expect(api.setStatus).not.toHaveBeenCalled();
    expect(api.comment.mock.calls[0][1]).toMatch(/usage limit reached/);
  });

  it("requeues a crashed run through the release endpoint, charging the attempt", async () => {
    const api = apiSpy();
    await createReporter(api, statuses).requeued(task, "the run timed out");

    expect(api.release).toHaveBeenCalledWith("t1", { refund: false });
    expect(api.setStatus).not.toHaveBeenCalled();
    expect(api.comment.mock.calls[0][1]).toMatch(/the run timed out/);
  });

  it("says which attempt failed when it requeues, so a board reader can see them climb", async () => {
    const api = apiSpy();
    await createReporter(api, statuses).requeued({ ...task, attempts: 2 }, "the run timed out");

    expect(api.comment.mock.calls[0][1]).toMatch(/attempt 2/);
  });

  it("survives a release endpoint that rejects a requeue", async () => {
    const api = apiSpy();
    api.release.mockRejectedValue(new Error("503"));

    await expect(
      createReporter(api, statuses, vi.fn()).requeued(task, "the run timed out")
    ).resolves.toBeUndefined();
  });

  it("closes a merged task in the board's done column with the PR url", async () => {
    const api = apiSpy();
    await createReporter(api, statuses).merged(task, "https://github.com/x/y/pull/7", "added the thing");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "shipped");
    expect(api.comment.mock.calls[0][1]).toMatch(/pull\/7/);
    expect(api.comment.mock.calls[0][1]).toMatch(/added the thing/);
  });

  it("comments before it moves the task, so the reason survives a failed status update", async () => {
    const api = apiSpy();
    await createReporter(api, statuses).merged(task, "https://x/pull/7", "done");

    expect(api.comment.mock.invocationCallOrder[0]).toBeLessThan(api.setStatus.mock.invocationCallOrder[0]);
  });

  it("comments before it releases, so the reason survives a failed release", async () => {
    const api = apiSpy();
    await createReporter(api, statuses).released(task, "usage limit reached");

    expect(api.comment.mock.invocationCallOrder[0]).toBeLessThan(api.release.mock.invocationCallOrder[0]);
  });

  it("comments even when the status update fails, so nothing is silently lost", async () => {
    const api = apiSpy();
    api.setStatus.mockRejectedValue(new Error("boom"));
    await expect(createReporter(api, statuses, vi.fn()).blocked(task, "x")).resolves.toBeUndefined();
    expect(api.comment).toHaveBeenCalled();
  });

  it("still moves the task when the comment fails", async () => {
    const api = apiSpy();
    api.comment.mockRejectedValue(new Error("boom"));
    await expect(createReporter(api, statuses, vi.fn()).blocked(task, "x")).resolves.toBeUndefined();
    expect(api.setStatus).toHaveBeenCalledWith("t1", "checking");
  });

  it("survives an api client that throws synchronously", async () => {
    const api = apiSpy();
    api.comment.mockImplementation(() => {
      throw new Error("no fetch");
    });
    api.setStatus.mockImplementation(() => {
      throw new Error("no fetch");
    });
    await expect(createReporter(api, statuses, vi.fn()).merged(task, "url", "s")).resolves.toBeUndefined();
  });

  it("survives a release endpoint that throws synchronously", async () => {
    const api = apiSpy();
    api.release.mockImplementation(() => {
      throw new Error("no fetch");
    });
    await expect(createReporter(api, statuses, vi.fn()).released(task, "usage limit reached")).resolves.toBeUndefined();
  });

  it("logs to stderr by default so an unattended run leaves a trace", async () => {
    const api = apiSpy();
    api.setStatus.mockRejectedValue(new Error("board is down"));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await createReporter(api, statuses).blocked(task, "x");

    expect(stderr).toHaveBeenCalledTimes(1);
    stderr.mockRestore();
  });

  it("logs a swallowed reporting failure instead of failing silently", async () => {
    const api = apiSpy();
    api.setStatus.mockRejectedValue(new Error("board is down"));
    const log = vi.fn();

    await createReporter(api, statuses, log).blocked(task, "x");

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/CP-158/);
    expect(log.mock.calls[0][0]).toMatch(/checking/);
    expect(log.mock.calls[0][0]).toMatch(/board is down/);
  });

  it("logs a failed release instead of dropping the task silently", async () => {
    const api = apiSpy();
    api.release.mockRejectedValue(new Error("board is down"));
    const log = vi.fn();

    await createReporter(api, statuses, log).released(task, "usage limit reached");

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/CP-158/);
    expect(log.mock.calls[0][0]).toMatch(/board is down/);
  });

  it("caps an oversized agent-authored reason", async () => {
    const api = apiSpy();
    await createReporter(api, statuses).blocked(task, "x".repeat(50_000));

    const body = api.comment.mock.calls[0][1];
    expect(body.length).toBeLessThan(3000);
    expect(body).toMatch(/truncated/);
  });

  it("caps an oversized agent-authored summary", async () => {
    const api = apiSpy();
    await createReporter(api, statuses).merged(task, "https://x/pull/7", "y".repeat(50_000));

    expect(api.comment.mock.calls[0][1].length).toBeLessThan(3000);
  });

  it("does not repeat the release comment when the same task is released for the same reason", async () => {
    const api = apiSpy();
    const reporter = createReporter(api, statuses);

    await reporter.released(task, "usage limit reached");
    await reporter.released(task, "usage limit reached");

    expect(api.comment).toHaveBeenCalledTimes(1);
    expect(api.release).toHaveBeenCalledTimes(2);
  });

  it("comments for every task released for the same reason, not just the first", async () => {
    const api = apiSpy();
    const reporter = createReporter(api, statuses);

    await reporter.released(task, "usage limit reached");
    await reporter.released({ ...task, taskId: "t2", taskKey: "CP-159" }, "usage limit reached");

    expect(api.comment).toHaveBeenCalledTimes(2);
    expect(api.comment.mock.calls[1][0]).toBe("t2");
  });

  it("retries the release comment when the first one never landed", async () => {
    const api = apiSpy();
    const reporter = createReporter(api, statuses, vi.fn());
    api.comment.mockRejectedValueOnce(new Error("board is down"));

    await reporter.released(task, "usage limit reached");
    await reporter.released(task, "usage limit reached");

    expect(api.comment).toHaveBeenCalledTimes(2);
  });

  it("comments again when a release reason changes", async () => {
    const api = apiSpy();
    const reporter = createReporter(api, statuses);

    await reporter.released(task, "usage limit reached");
    await reporter.released(task, "the run timed out");

    expect(api.comment).toHaveBeenCalledTimes(2);
  });

  it("comments again on a release that follows another outcome", async () => {
    const api = apiSpy();
    const reporter = createReporter(api, statuses);

    await reporter.released(task, "usage limit reached");
    await reporter.blocked(task, "ambiguous");
    await reporter.released(task, "usage limit reached");

    expect(api.comment).toHaveBeenCalledTimes(3);
  });

  it("names the attempt it gave up on without mangling the grammar", async () => {
    const api = apiSpy();
    await createReporter(api, statuses).failed(task, "merge failed");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "checking");
    expect(api.comment.mock.calls[0][1]).toMatch(/attempt 1\b/);
    expect(api.comment.mock.calls[0][1]).not.toMatch(/1 attempts/);
    expect(api.comment.mock.calls[0][1]).toMatch(/merge failed/);
  });

  it("omits the attempt count when the board did not report one", async () => {
    const api = apiSpy();
    await createReporter(api, statuses).failed({ ...task, attempts: 0 }, "merge failed");

    expect(api.comment.mock.calls[0][1]).not.toMatch(/attempt 0/);
    expect(api.comment.mock.calls[0][1]).toMatch(/merge failed/);
  });
});

describe("reports the server refused", () => {
  function outboxSpy() {
    return { add: vi.fn(), flush: vi.fn(), pending: vi.fn().mockReturnValue(0) };
  }

  it("queues a merge comment the server would not take, so the task is not stranded", async () => {
    const api = apiSpy();
    api.comment.mockRejectedValue(new Error("502 Bad Gateway"));
    const outbox = outboxSpy();

    await createReporter(api, statuses, vi.fn(), outbox).merged(task, "https://x/pull/7", "did it");

    expect(outbox.add).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "comment", taskId: "t1" })
    );
  });

  it("queues the status move too, so the board catches up on both", async () => {
    const api = apiSpy();
    api.setStatus.mockRejectedValue(new Error("502"));
    const outbox = outboxSpy();

    await createReporter(api, statuses, vi.fn(), outbox).merged(task, "https://x/pull/7", "did it");

    expect(outbox.add).toHaveBeenCalledWith({ kind: "status", taskId: "t1", status: "shipped" });
  });

  it("preserves the refund flag when a requeue cannot be delivered", async () => {
    const api = apiSpy();
    api.release.mockRejectedValue(new Error("503"));
    const outbox = outboxSpy();

    await createReporter(api, statuses, vi.fn(), outbox).requeued(task, "timed out");

    expect(outbox.add).toHaveBeenCalledWith({ kind: "release", taskId: "t1", refund: false });
  });

  it("marks a usage-limit release as refunding", async () => {
    const api = apiSpy();
    api.release.mockRejectedValue(new Error("503"));
    const outbox = outboxSpy();

    await createReporter(api, statuses, vi.fn(), outbox).released(task, "usage limit reached");

    expect(outbox.add).toHaveBeenCalledWith({ kind: "release", taskId: "t1", refund: true });
  });

  it("queues nothing when the server accepts the report", async () => {
    const outbox = outboxSpy();

    await createReporter(apiSpy(), statuses, vi.fn(), outbox).merged(task, "https://x/pull/7", "ok");

    expect(outbox.add).not.toHaveBeenCalled();
  });
});
