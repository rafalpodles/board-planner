import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BP-610. A pull request that stops matching a task used to leave that task out of the sync's
 * grouping entirely, so its stale link survived every subsequent sync.
 *
 * What is pinned here is the *decision* — which stored links a round of the sync has contradicted.
 * The obvious rule, "remove anything this round did not confirm", is the one thing these tests
 * exist to refuse: neither provider is asked for its whole history, so a correct link falls out of
 * the fetch window on its own. What the pipelines below actually do to a document is asserted
 * against a real database in `e2e/pr-link-pruning.spec.ts`.
 */

const { taskFind, taskUpdateOne } = vi.hoisted(() => ({
  taskFind: vi.fn(),
  taskUpdateOne: vi.fn(),
}));

vi.mock("@/models/task", () => ({ Task: { find: taskFind, updateOne: taskUpdateOne } }));

const { contradictedLinkNumbers, pruneContradictedLinks, removeProviderLinks } = await import(
  "./pr-links"
);

const nothingIsElsewhere = () => false;

function link(over: Partial<{ provider: "github" | "gitlab" | null; number: number; url: string }>) {
  return {
    provider: over.provider === undefined ? ("github" as const) : over.provider,
    number: over.number ?? 1,
    url: over.url ?? "https://github.com/o/r/pull/1",
  };
}

describe("contradictedLinkNumbers", () => {
  it("removes a pull request this round saw that no longer matches the task", () => {
    const numbers = contradictedLinkNumbers(
      [link({ number: 7 })],
      "github",
      new Set([7]),
      nothingIsElsewhere
    );

    expect(numbers).toEqual([7]);
  });

  /**
   * The reason this function exists rather than "clear every task not in the grouping". GitHub is
   * asked for its open pull requests plus the thirty most recently updated closed ones; a task
   * whose pull request merged last quarter is outside that on every sync while being perfectly
   * correct. Sweeping it would destroy good data on healthy projects.
   */
  it("keeps a link whose pull request this round never saw", () => {
    const numbers = contradictedLinkNumbers(
      [link({ number: 7 })],
      "github",
      new Set([8, 9]),
      nothingIsElsewhere
    );

    expect(numbers).toEqual([]);
  });

  it("removes a link naming another repository even though this round never saw it", () => {
    const numbers = contradictedLinkNumbers(
      [link({ number: 7, url: "https://github.com/other/repo/pull/7" })],
      "github",
      new Set(),
      (url) => url.includes("/other/")
    );

    expect(numbers).toEqual([7]);
  });

  it("keeps a link whose URL cannot be read as naming any repository", () => {
    // The predicate answers false for anything it cannot parse, and only a positive reading of a
    // different repository may remove a link — a shape nobody anticipated must not delete data.
    const numbers = contradictedLinkNumbers(
      [link({ number: 7, url: "not-a-url" })],
      "github",
      new Set(),
      (url) => url.includes("/other/")
    );

    expect(numbers).toEqual([]);
  });

  it("treats a link stored before the provider field existed as GitHub's", () => {
    const legacy = [link({ provider: null, number: 7 })];

    expect(contradictedLinkNumbers(legacy, "github", new Set([7]), nothingIsElsewhere)).toEqual([7]);
    expect(contradictedLinkNumbers(legacy, "gitlab", new Set([7]), nothingIsElsewhere)).toEqual([]);
  });

  it("leaves the other provider's links alone even when the numbers collide", () => {
    const numbers = contradictedLinkNumbers(
      [link({ provider: "gitlab", number: 7 })],
      "github",
      new Set([7]),
      nothingIsElsewhere
    );

    expect(numbers).toEqual([]);
  });

  it("names a number once when a task holds the same pull request twice", () => {
    const numbers = contradictedLinkNumbers(
      [link({ number: 7 }), link({ number: 7 })],
      "github",
      new Set([7]),
      nothingIsElsewhere
    );

    expect(numbers).toEqual([7]);
  });
});

describe("pruneContradictedLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    taskFind.mockReturnValue({ lean: async () => [] });
  });

  const prune = (over: Record<string, unknown> = {}) =>
    pruneContradictedLinks({
      projectId: "p1",
      provider: "github",
      linkedThisRound: new Set<number>(),
      seenNumbers: new Set<number>(),
      namesAnotherRepository: nothingIsElsewhere,
      ...over,
    });

  /**
   * The schema's `provider` default is applied when Mongoose hydrates a document, not when one is
   * stored, so a link written before that field existed has no `provider` key for a query to match
   * — and it is GitHub's. `{"linkedPRs.provider": "github"}`, which the ticket proposed, misses
   * every one of them.
   */
  it("asks for the links an older database stored without a provider", async () => {
    await prune();

    const [filter] = taskFind.mock.calls[0];
    expect(filter.linkedPRs.$elemMatch).toEqual({
      $or: [{ provider: "github" }, { provider: { $exists: false } }, { provider: null }],
    });
  });

  it("asks only for GitLab's own links when GitLab syncs", async () => {
    await prune({ provider: "gitlab" });

    expect(taskFind.mock.calls[0][0].linkedPRs.$elemMatch).toEqual({ provider: "gitlab" });
  });

  it("removes a contradicted link through the database rather than by saving a read copy", async () => {
    taskFind.mockReturnValue({
      lean: async () => [
        { _id: "t1", taskNumber: 5, linkedPRs: [link({ number: 7 })] },
      ],
    });

    const removed = await prune({ seenNumbers: new Set([7]) });

    expect(removed).toBe(1);
    const [filter, update, options] = taskUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "t1" });
    expect(update).toEqual(removeProviderLinks("github", [7]));
    // Mongoose refuses a pipeline update without it, and a pipeline is the point: the surviving
    // array is computed from the document at write time, so an overlapping sync is not dropped.
    expect(options).toEqual({ updatePipeline: true });
  });

  it("writes nothing when a holder has nothing contradicted", async () => {
    taskFind.mockReturnValue({
      lean: async () => [{ _id: "t1", taskNumber: 5, linkedPRs: [link({ number: 7 })] }],
    });

    const removed = await prune({ seenNumbers: new Set([8]) });

    expect(removed).toBe(0);
    expect(taskUpdateOne).not.toHaveBeenCalled();
  });

  it("skips a task this round already rewrote wholesale", async () => {
    taskFind.mockReturnValue({
      lean: async () => [{ _id: "t1", taskNumber: 5, linkedPRs: [link({ number: 7 })] }],
    });

    const removed = await prune({ seenNumbers: new Set([7]), linkedThisRound: new Set([5]) });

    expect(removed).toBe(0);
    expect(taskUpdateOne).not.toHaveBeenCalled();
  });

  it("survives a holder whose linkedPRs field is absent", async () => {
    taskFind.mockReturnValue({ lean: async () => [{ _id: "t1", taskNumber: 5 }] });

    await expect(prune({ seenNumbers: new Set([7]) })).resolves.toBe(0);
  });
});
