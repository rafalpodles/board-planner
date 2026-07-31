import { describe, it, expect, vi } from "vitest";
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

function apiSpy() {
  return {
    claim: vi.fn(),
    setStatus: vi.fn<(taskId: string, status: string) => Promise<void>>().mockResolvedValue(undefined),
    comment: vi.fn<(taskId: string, body: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

describe("createReporter", () => {
  it("routes a blocked task to needs_human_review with the reason", async () => {
    const api = apiSpy();
    await createReporter(api).blocked(task, "requirements are ambiguous");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "needs_human_review");
    expect(api.comment.mock.calls[0][1]).toMatch(/requirements are ambiguous/);
  });

  it("names the gate and the pushed branch when a gate rejects", async () => {
    const api = apiSpy();
    await createReporter(api).gateRejected(task, "diff-size", "diff is 900 lines, limit is 400", "cp-158/worker");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "needs_human_review");
    expect(api.comment.mock.calls[0][1]).toMatch(/diff-size/);
    expect(api.comment.mock.calls[0][1]).toMatch(/900 lines/);
    expect(api.comment.mock.calls[0][1]).toMatch(/cp-158\/worker/);
  });

  it("returns a released task to todo", async () => {
    const api = apiSpy();
    await createReporter(api).released(task, "usage limit reached");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "todo");
    expect(api.comment.mock.calls[0][1]).toMatch(/usage limit reached/);
  });

  it("closes a merged task as done with the PR url", async () => {
    const api = apiSpy();
    await createReporter(api).merged(task, "https://github.com/x/y/pull/7", "added the thing");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "done");
    expect(api.comment.mock.calls[0][1]).toMatch(/pull\/7/);
    expect(api.comment.mock.calls[0][1]).toMatch(/added the thing/);
  });

  it("comments before it moves the task, so the reason survives a failed status update", async () => {
    const api = apiSpy();
    await createReporter(api).merged(task, "https://x/pull/7", "done");

    expect(api.comment.mock.invocationCallOrder[0]).toBeLessThan(api.setStatus.mock.invocationCallOrder[0]);
  });

  it("comments even when the status update fails, so nothing is silently lost", async () => {
    const api = apiSpy();
    api.setStatus.mockRejectedValue(new Error("boom"));
    await expect(createReporter(api, vi.fn()).blocked(task, "x")).resolves.toBeUndefined();
    expect(api.comment).toHaveBeenCalled();
  });

  it("still moves the task when the comment fails", async () => {
    const api = apiSpy();
    api.comment.mockRejectedValue(new Error("boom"));
    await expect(createReporter(api, vi.fn()).blocked(task, "x")).resolves.toBeUndefined();
    expect(api.setStatus).toHaveBeenCalledWith("t1", "needs_human_review");
  });

  it("survives an api client that throws synchronously", async () => {
    const api = apiSpy();
    api.comment.mockImplementation(() => {
      throw new Error("no fetch");
    });
    api.setStatus.mockImplementation(() => {
      throw new Error("no fetch");
    });
    await expect(createReporter(api, vi.fn()).merged(task, "url", "s")).resolves.toBeUndefined();
  });

  it("logs to stderr by default so an unattended run leaves a trace", async () => {
    const api = apiSpy();
    api.setStatus.mockRejectedValue(new Error("board is down"));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await createReporter(api).blocked(task, "x");

    expect(stderr).toHaveBeenCalledTimes(1);
    stderr.mockRestore();
  });

  it("logs a swallowed reporting failure instead of failing silently", async () => {
    const api = apiSpy();
    api.setStatus.mockRejectedValue(new Error("board is down"));
    const log = vi.fn();

    await createReporter(api, log).blocked(task, "x");

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/CP-158/);
    expect(log.mock.calls[0][0]).toMatch(/needs_human_review/);
    expect(log.mock.calls[0][0]).toMatch(/board is down/);
  });

  it("caps an oversized agent-authored reason", async () => {
    const api = apiSpy();
    await createReporter(api).blocked(task, "x".repeat(50_000));

    const body = api.comment.mock.calls[0][1];
    expect(body.length).toBeLessThan(3000);
    expect(body).toMatch(/truncated/);
  });

  it("caps an oversized agent-authored summary", async () => {
    const api = apiSpy();
    await createReporter(api).merged(task, "https://x/pull/7", "y".repeat(50_000));

    expect(api.comment.mock.calls[0][1].length).toBeLessThan(3000);
  });

  it("does not repeat the release comment when the same task is released for the same reason", async () => {
    const api = apiSpy();
    const reporter = createReporter(api);

    await reporter.released(task, "usage limit reached");
    await reporter.released(task, "usage limit reached");

    expect(api.comment).toHaveBeenCalledTimes(1);
    expect(api.setStatus).toHaveBeenCalledTimes(2);
  });

  it("retries the release comment when the first one never landed", async () => {
    const api = apiSpy();
    const reporter = createReporter(api, vi.fn());
    api.comment.mockRejectedValueOnce(new Error("board is down"));

    await reporter.released(task, "usage limit reached");
    await reporter.released(task, "usage limit reached");

    expect(api.comment).toHaveBeenCalledTimes(2);
  });

  it("comments again when a release reason changes", async () => {
    const api = apiSpy();
    const reporter = createReporter(api);

    await reporter.released(task, "usage limit reached");
    await reporter.released(task, "the run timed out");

    expect(api.comment).toHaveBeenCalledTimes(2);
  });

  it("comments again on a release that follows another outcome", async () => {
    const api = apiSpy();
    const reporter = createReporter(api);

    await reporter.released(task, "usage limit reached");
    await reporter.blocked(task, "ambiguous");
    await reporter.released(task, "usage limit reached");

    expect(api.comment).toHaveBeenCalledTimes(3);
  });

  it("names the attempt it gave up on without mangling the grammar", async () => {
    const api = apiSpy();
    await createReporter(api).failed(task, "merge failed");

    expect(api.setStatus).toHaveBeenCalledWith("t1", "needs_human_review");
    expect(api.comment.mock.calls[0][1]).toMatch(/attempt 1\b/);
    expect(api.comment.mock.calls[0][1]).not.toMatch(/1 attempts/);
    expect(api.comment.mock.calls[0][1]).toMatch(/merge failed/);
  });

  it("omits the attempt count when the board did not report one", async () => {
    const api = apiSpy();
    await createReporter(api).failed({ ...task, attempts: 0 }, "merge failed");

    expect(api.comment.mock.calls[0][1]).not.toMatch(/attempt 0/);
    expect(api.comment.mock.calls[0][1]).toMatch(/merge failed/);
  });
});
