import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ILinkedPR } from "@/types";

const { logActivity, taskUpdateOne } = vi.hoisted(() => ({
  logActivity: vi.fn(),
  taskUpdateOne: vi.fn(),
}));

vi.mock("@/lib/activity", () => ({ logActivity }));
vi.mock("@/models/task", () => ({ Task: { updateOne: taskUpdateOne } }));

const {
  addedLinks,
  droppedCount,
  recordLinkChanges,
  removedLinks,
  seenUrls,
  unseenLinks,
} = await import("./pr-links");

const REPO = "https://github.com/example/board";
// The address follows the number unless the caller names one: a fixture where it does not is a
// link to #1 wearing another number, which no url-scoped rule can tell from its neighbour.
const link = (over: Partial<ILinkedPR>): ILinkedPR =>
  ({
    number: 1,
    title: "Some change",
    state: "open",
    url: `${REPO}/pull/${over.number ?? 1}`,
    provider: "github",
    ...over,
  }) as ILinkedPR;

beforeEach(() => {
  logActivity.mockReset();
  taskUpdateOne.mockReset();
});

/**
 * BP-631. The round used to name what it saw by number, which is only unique inside one
 * repository — so the moment a project's `repositoryUrl` moved, the new repository's numbers
 * contradicted the old one's links.
 */
describe("seenUrls", () => {
  it("is what the fetch returned", () => {
    expect(seenUrls("github", REPO, [{ number: 9, url: `${REPO}/pull/9` }])).toEqual([
      `${REPO}/pull/9`,
    ]);
  });

  // The rename case. GitHub follows a redirect and answers with the repository's *new* name, while
  // the project still names the old one — so the stored links are addressed the old way and
  // nothing in the fetch would ever contradict them again.
  it("also claims the address the project's own repository would give", () => {
    expect(
      seenUrls("github", "https://github.com/example/old-name", [
        { number: 9, url: `${REPO}/pull/9` },
      ])
    ).toEqual([`${REPO}/pull/9`, "https://github.com/example/old-name/pull/9"]);
  });

  it("says the same thing twice only once", () => {
    expect(seenUrls("github", REPO, [{ number: 9, url: `${REPO}/pull/9` }])).toHaveLength(1);
  });

  it("tolerates the spellings a repository url is stored in", () => {
    expect(seenUrls("github", `${REPO}.git/`, [{ number: 2 }])).toEqual([`${REPO}/pull/2`]);
  });

  it("knows where GitLab puts the number", () => {
    expect(seenUrls("gitlab", "https://gitlab.com/g/p", [{ number: 3 }])).toEqual([
      "https://gitlab.com/g/p/-/merge_requests/3",
    ]);
  });

  it("claims nothing of its own for a project that names no repository", () => {
    expect(seenUrls("github", "", [{ number: 4, url: `${REPO}/pull/4` }])).toEqual([
      `${REPO}/pull/4`,
    ]);
  });
});

describe("what a round contradicts", () => {
  const seen = new Set(seenUrls("github", REPO, [{ number: 12, url: `${REPO}/pull/12` }]));

  it("drops a link this round saw and gave to somebody else", () => {
    expect(removedLinks([link({ number: 12 })], "github", seen, new Set())).toHaveLength(1);
  });

  it("keeps the one it gave back to the same task", () => {
    expect(
      removedLinks([link({ number: 12 })], "github", seen, new Set([`${REPO}/pull/12`]))
    ).toHaveLength(0);
  });

  // The defect this ticket is: #12 of a repository this round never read is not this round's to
  // contradict, however loudly its own #12 disagrees.
  it("says nothing about the same number in another repository", () => {
    const elsewhere = link({ number: 12, url: "https://github.com/example/previous/pull/12" });

    expect(removedLinks([elsewhere], "github", seen, new Set())).toEqual([]);
    expect(droppedCount([elsewhere], "github", seen, new Set())).toBe(0);
    expect(unseenLinks([elsewhere], "github", seen)).toEqual([elsewhere]);
  });

  it("leaves the other provider's links alone", () => {
    const gitlab = link({ provider: "gitlab", number: 12, url: `${REPO}/pull/12` });
    expect(removedLinks([gitlab], "github", seen, new Set())).toEqual([]);
  });

  // Written before the provider field existed, which the schema fills in on hydration rather than
  // storing — the shape the second pass goes out of its way to find
  it("owns an unmarked link", () => {
    const unmarked = { number: 12, title: "old", state: "open", url: `${REPO}/pull/12` };
    expect(removedLinks([unmarked as ILinkedPR], "github", seen, new Set())).toHaveLength(1);
  });

  // The schema requires a url and only the two syncs write links, so this is a shape nothing can
  // identify — and keeping it is the safe direction
  it("keeps a link carrying no address at all", () => {
    const nameless = { number: 12, title: "old", state: "open" } as unknown as ILinkedPR;
    expect(removedLinks([nameless], "github", seen, new Set())).toEqual([]);
  });
});

describe("addedLinks", () => {
  it("is what the task was not already holding", () => {
    const docs = [{ url: `${REPO}/pull/1` }, { url: `${REPO}/pull/2` }];
    expect(addedLinks([link({ number: 1 })], "github", docs)).toEqual([{ url: `${REPO}/pull/2` }]);
  });

  // A round that only refreshed a badge writes the task but adds nothing, and must stay silent
  it("is empty when the round matched what was already there", () => {
    expect(addedLinks([link({ number: 1 })], "github", [{ url: `${REPO}/pull/1` }])).toEqual([]);
  });

  it("does not count the other provider's link as already held", () => {
    const gitlab = link({ provider: "gitlab", url: `${REPO}/pull/1` });
    expect(addedLinks([gitlab], "github", [{ url: `${REPO}/pull/1` }])).toHaveLength(1);
  });
});

/** BP-628: the trace a link change leaves on the task it changed. */
describe("recordLinkChanges", () => {
  it("writes a row for each side, naming the address", async () => {
    await recordLinkChanges(
      "t1",
      "u1",
      [{ url: `${REPO}/pull/2` }],
      [{ url: `${REPO}/pull/1` }]
    );

    expect(logActivity.mock.calls).toEqual([
      ["t1", "u1", "pr_unlinked", "linkedPRs", `${REPO}/pull/1`, ""],
      ["t1", "u1", "pr_linked", "linkedPRs", "", `${REPO}/pull/2`],
    ]);
  });

  // The absence that stops the auto-transition writing a row is not a reason to leave the link
  // change untraceable: nobody authored what GitHub says
  it("keeps a scheduled round's row authorless rather than borrowing a name", async () => {
    await recordLinkChanges("t1", null, [], [{ url: `${REPO}/pull/1` }]);

    expect(logActivity).toHaveBeenCalledWith(
      "t1",
      null,
      "pr_unlinked",
      "linkedPRs",
      `${REPO}/pull/1`,
      ""
    );
  });

  it("writes nothing when nothing changed", async () => {
    await recordLinkChanges("t1", "u1", [], []);
    expect(logActivity).not.toHaveBeenCalled();
  });

  // It is a row in a different collection, which is the whole reason it is affordable: a task
  // write is what BP-443 and BP-627 removed
  it("does not touch the task", async () => {
    await recordLinkChanges("t1", "u1", [{ url: `${REPO}/pull/2` }], []);
    expect(taskUpdateOne).not.toHaveBeenCalled();
  });
});
