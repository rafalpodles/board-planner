import { describe, it, expect, vi } from "vitest";
import { PullRequestState } from "./delivery.js";
import { OutboxOp, Store } from "./outbox.js";
import { CHECK_INTERVAL_MS, createQueuedMerges, QueuedMerge, watchQueuedMerges, WATCH_LIMIT_MS } from "./queued-merges.js";

const T0 = Date.parse("2026-11-03T10:00:00Z");

function memoryStore(text = ""): Store & { text: string } {
  return {
    text,
    read() {
      return this.text;
    },
    write(next: string) {
      this.text = next;
    },
  };
}

function queued(overrides: Partial<QueuedMerge> = {}): QueuedMerge {
  return {
    projectId: "CP",
    taskId: "t1",
    taskKey: "CP-1",
    prUrls: ["https://github.com/x/y/pull/7"],
    review: "checking",
    done: "shipped",
    queuedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

function rig(entries: QueuedMerge[], states: Record<string, PullRequestState>, now = T0) {
  const store = memoryStore();
  const merges = createQueuedMerges(store, vi.fn());
  merges.replace(entries);
  const ops: OutboxOp[] = [];
  const pullRequestState = vi.fn(async (url: string) => states[url] ?? "unknown");
  const watch = (at = now) => watchQueuedMerges({ merges, pullRequestState, outbox: { add: (op) => ops.push(op) }, now: () => at });
  return { store, merges, ops, pullRequestState, watch };
}

describe("watchQueuedMerges (BP-1128)", () => {
  it("moves the task to done from review once GitHub has merged the pull request, saying so first", async () => {
    const { merges, ops, watch } = rig([queued()], { "https://github.com/x/y/pull/7": "merged" });

    await watch();

    expect(ops).toEqual([
      { kind: "comment", projectId: "CP", taskId: "t1", body: "GitHub merged https://github.com/x/y/pull/7." },
      { kind: "status", projectId: "CP", taskId: "t1", status: "shipped", from: "checking" },
    ]);
    expect(merges.list()).toEqual([]);
  });

  it("leaves the task in review with a comment when the pull request was closed unmerged", async () => {
    const { merges, ops, watch } = rig([queued()], { "https://github.com/x/y/pull/7": "closed" });

    await watch();

    expect(ops).toEqual([
      {
        kind: "comment",
        projectId: "CP",
        taskId: "t1",
        body: "https://github.com/x/y/pull/7 was closed without being merged, so the task stays here.",
      },
    ]);
    expect(merges.list()).toEqual([]);
  });

  it("keeps watching an open pull request, and does not ask again before the interval", async () => {
    const { merges, ops, pullRequestState, watch } = rig([queued()], { "https://github.com/x/y/pull/7": "open" });

    await watch();
    await watch(T0 + CHECK_INTERVAL_MS - 1);

    expect(ops).toEqual([]);
    expect(pullRequestState).toHaveBeenCalledTimes(1);
    expect(merges.list()).toEqual([expect.objectContaining({ taskId: "t1", checkedAt: new Date(T0).toISOString() })]);

    await watch(T0 + CHECK_INTERVAL_MS);
    expect(pullRequestState).toHaveBeenCalledTimes(2);
  });

  it("keeps watching when gh could not answer", async () => {
    const { merges, ops, watch } = rig([queued()], {});

    await watch();

    expect(ops).toEqual([]);
    expect(merges.list()).toHaveLength(1);
  });

  it("keeps watching every entry when asking gh throws for one of them", async () => {
    const { merges, ops, pullRequestState, watch } = rig(
      [queued(), queued({ taskId: "t2", prUrls: ["https://github.com/x/y/pull/8"] })],
      { "https://github.com/x/y/pull/8": "merged" }
    );
    pullRequestState.mockImplementationOnce(async () => {
      throw new Error("gh is not resolved");
    });

    await watch();

    expect(merges.list().map((entry) => entry.taskId)).toEqual(["t1"]);
    expect(ops).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "status", taskId: "t2" })]));
  });

  it("moves a task with several repositories only once every pull request has merged", async () => {
    const prUrls = ["https://github.com/x/y/pull/7", "https://github.com/x/z/pull/8"];
    const { ops, watch } = rig([queued({ prUrls })], { [prUrls[0]]: "merged", [prUrls[1]]: "open" });

    await watch();

    expect(ops).toEqual([]);
  });

  it("names only the closed one of several pull requests", async () => {
    const prUrls = ["https://github.com/x/y/pull/7", "https://github.com/x/z/pull/8"];
    const { ops, watch } = rig([queued({ prUrls })], { [prUrls[0]]: "merged", [prUrls[1]]: "closed" });

    await watch();

    expect(ops).toEqual([expect.objectContaining({ kind: "comment", body: expect.stringMatching(/^https:\/\/github.com\/x\/z\/pull\/8 was closed/) })]);
  });

  it("stops watching after the limit with a comment, leaving the task in review", async () => {
    const { merges, ops, watch } = rig([queued()], { "https://github.com/x/y/pull/7": "open" });

    await watch(T0 + WATCH_LIMIT_MS + 1);

    expect(ops).toEqual([expect.objectContaining({ kind: "comment", body: expect.stringMatching(/stopped watching/) })]);
    expect(merges.list()).toEqual([]);
  });

  it("survives a restart, because a new instance reads the same store", async () => {
    const store = memoryStore();
    createQueuedMerges(store).add(queued());

    expect(createQueuedMerges(store).list()).toEqual([queued()]);
  });

  it("replaces an earlier watch on the same task rather than reporting it twice", () => {
    const merges = createQueuedMerges(memoryStore());
    merges.add(queued());
    merges.add(queued({ prUrls: ["https://github.com/x/y/pull/9"] }));

    expect(merges.list()).toEqual([queued({ prUrls: ["https://github.com/x/y/pull/9"] })]);
  });

  it("reads an unreadable store as nothing to watch", () => {
    expect(createQueuedMerges(memoryStore("{not json")).list()).toEqual([]);
    expect(createQueuedMerges(memoryStore('[{"taskId":"t1"}]')).list()).toEqual([]);
  });
});
