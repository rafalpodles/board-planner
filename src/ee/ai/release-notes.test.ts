import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  histories: vi.fn(),
  fetchMergedPullRequests: vi.fn(),
  fetchMergedRequests: vi.fn(),
  gatewayWrite: vi.fn(),
}));

vi.mock("@/lib/status-history", () => ({ projectStatusHistories: m.histories }));
vi.mock("@/lib/github", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/github")>()), fetchMergedPullRequests: m.fetchMergedPullRequests }));
vi.mock("@/lib/gitlab", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/gitlab")>()), fetchMergedRequests: m.fetchMergedRequests }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: () => "token" }));
vi.mock("@/lib/ai-gateway", () => ({ gatewayWrite: m.gatewayWrite }));
vi.mock("@/lib/pm/availability", () => ({ resolveAiModel: async () => "openai/gpt-6-luna" }));

const { releaseMaterial, isEmpty, releaseNoteInstructions, writeReleaseNotes, MAX_TASKS } = await import("./release-notes");

const WINDOW = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-14T23:59:59.999Z"), label: "1 to 14 October" };

const history = (taskNumber: number, finishedAt: string | null, over: Record<string, unknown> = {}) => ({
  taskId: `t${taskNumber}`,
  taskNumber,
  title: `Task ${taskNumber}`,
  category: taskNumber % 2 ? "bug" : "user-story",
  role: "done",
  archived: false,
  sprint: null,
  history: finishedAt ? { kind: "recorded", finishedAt: new Date(finishedAt) } : { kind: "no-history" },
  ...over,
});

function fakeDb(project: Record<string, unknown> = {}, linked: string[] = []) {
  const lean = <T>(value: T) => ({ lean: async () => value });
  const queries: Record<string, unknown>[] = [];
  return {
    queries,
    db: {
      organisation: "org",
      Project: { findById: () => lean({ key: "TP", ...project }) },
      Task: {
        find: (filter: Record<string, unknown>) => {
          queries.push(filter);
          if (filter["linkedPRs.url"]) return lean([{ linkedPRs: linked.map((url) => ({ url })) }]);
          return lean([
            { _id: "t1", description: "Fixed the export", linkedPRs: [{ title: "Fix export", url: "https://github.com/o/r/pull/1", mergedAt: new Date("2026-10-02") }, { title: "Draft", url: "u2", mergedAt: null }] },
            { _id: "t2", description: "", linkedPRs: [] },
          ]);
        },
      },
    } as never,
  };
}

const GITHUB = { repositoryUrl: "https://github.com/o/r", githubToken: "sealed" };

beforeEach(() => Object.values(m).forEach((fn) => fn.mockReset()));

describe("releaseMaterial", () => {
  it("takes the tasks that reached a done column inside the window, its first and last instant included", async () => {
    m.histories.mockResolvedValue([
      history(1, "2026-10-01T00:00:00Z"),
      history(2, "2026-10-14T23:59:59.999Z"),
      history(3, "2026-09-30T23:59:59.999Z"),
      history(4, "2026-10-15T00:00:00Z"),
      history(5, "2026-10-05T00:00:00Z", { role: "active" }),
      history(6, "2026-10-05T00:00:00Z", { archived: true }),
      history(7, null),
    ]);
    const { db, queries } = fakeDb();
    const material = await releaseMaterial(db, "p1", WINDOW);
    expect(material!.tasks).toEqual([
      { key: "TP-1", title: "Task 1", category: "bug", description: "Fixed the export", pullRequests: [{ title: "Fix export", url: "https://github.com/o/r/pull/1", mergedAt: "2026-10-02T00:00:00.000Z" }] },
      { key: "TP-2", title: "Task 2", category: "user-story", description: "", pullRequests: [] },
    ]);
    expect(queries[0]).toMatchObject({ project: "p1", archivedAt: null });
    expect(m.fetchMergedPullRequests).not.toHaveBeenCalled();
  });

  it("takes a sprint's own finished tasks, whenever they finished, and none of a neighbouring sprint's", async () => {
    m.histories.mockResolvedValue([
      history(1, "2026-09-20T00:00:00Z", { sprint: "s1" }),
      history(2, null, { sprint: "s1" }),
      history(3, "2026-10-05T00:00:00Z", { sprint: "s2" }),
      history(4, "2026-10-05T00:00:00Z", { sprint: "s1", role: "active" }),
    ]);
    const material = await releaseMaterial(fakeDb().db, "p1", { ...WINDOW, sprintId: "s1" });
    expect(material!.tasks.map((t) => t.key)).toEqual(["TP-1", "TP-2"]);
  });

  it("adds the merges in the window no task of the board links", async () => {
    m.histories.mockResolvedValue([]);
    m.fetchMergedPullRequests.mockResolvedValue({
      pulls: [
        { title: "Bump deps", url: "https://github.com/o/r/pull/7", mergedAt: "2026-10-04T00:00:00Z" },
        { title: "Linked elsewhere", url: "https://github.com/o/r/pull/8", mergedAt: "2026-10-04T00:00:00Z" },
        { title: "Same day, after the window", url: "https://github.com/o/r/pull/9", mergedAt: "2026-10-15T00:00:01Z" },
      ],
      complete: true,
    });
    const material = await releaseMaterial(fakeDb(GITHUB, ["https://github.com/o/r/pull/8"]).db, "p1", WINDOW);
    expect(material!.pullRequestsWithoutTask).toEqual([{ title: "Bump deps", url: "https://github.com/o/r/pull/7", mergedAt: "2026-10-04T00:00:00Z" }]);
    expect(m.fetchMergedPullRequests).toHaveBeenCalledWith("o", "r", "token", WINDOW.from, WINDOW.to);
    expect(material!.pullRequestsIncomplete).toBe(false);
    expect(isEmpty(material!)).toBe(false);
  });

  it("reads a GitLab project's merge requests, and says when there were more than it could read", async () => {
    m.histories.mockResolvedValue([]);
    m.fetchMergedRequests.mockResolvedValue({
      requests: [
        { iid: 3, title: "Fix login", web_url: "https://gitlab.com/g/p/-/merge_requests/3", merged_at: "2026-10-03T00:00:00Z", state: "merged" },
        { iid: 2, title: "Before", web_url: "https://gitlab.com/g/p/-/merge_requests/2", merged_at: "2026-09-03T00:00:00Z", state: "merged" },
      ],
      complete: false,
    });
    const material = await releaseMaterial(fakeDb({ gitlabRepo: "https://gitlab.com/g/p", gitlabToken: "sealed" }).db, "p1", WINDOW);
    expect(material!.pullRequestsWithoutTask.map((pr) => pr.title)).toEqual(["Fix login"]);
    expect(material!.pullRequestsIncomplete).toBe(true);
  });

  it("still covers the tasks when the repository cannot be read, and says only that it could not", async () => {
    m.histories.mockResolvedValue([history(1, "2026-10-03T10:00:00Z")]);
    m.fetchMergedPullRequests.mockRejectedValue(new Error("10.0.0.5 refused, token sk-123"));
    const material = await releaseMaterial(fakeDb(GITHUB).db, "p1", WINDOW);
    expect(material!.tasks).toHaveLength(1);
    expect(material!.repositoryUnread).toBe(true);
    expect(JSON.stringify(material)).not.toContain("10.0.0.5");
  });

  it("keeps at most so many tasks, and counts the rest", async () => {
    m.histories.mockResolvedValue(Array.from({ length: MAX_TASKS + 4 }, (_, i) => history(i + 1, "2026-10-03T10:00:00Z")));
    const material = await releaseMaterial(fakeDb().db, "p1", WINDOW);
    expect(material!.tasks).toHaveLength(MAX_TASKS);
    expect(material!.tasksLeftOut).toBe(4);
  });

  it("calls a window with nothing in it empty", async () => {
    m.histories.mockResolvedValue([history(3, "2026-09-30T00:00:00Z")]);
    expect(isEmpty((await releaseMaterial(fakeDb().db, "p1", WINDOW))!)).toBe(true);
  });
});

describe("writing the notes", () => {
  it("asks for every item once, grouped by category, inventing nothing, in the tone chosen, and to say when the list is short", () => {
    expect(releaseNoteInstructions("changelog")).toMatch(/developers[^]*heading per category[^]*Other changes[^]*every task and every pull request given, once, and nothing that is not given[^]*tasksLeftOut/);
    expect(releaseNoteInstructions("customer")).toMatch(/customers/);
  });

  it("goes through the gateway as release notes, with the material as data", async () => {
    m.gatewayWrite.mockResolvedValue({ ok: true, text: "## Bug\n- x" });
    const material = { window: { from: "a", to: "b", label: "S" }, tasks: [], pullRequestsWithoutTask: [], tasksLeftOut: 0, pullRequestsIncomplete: false, repositoryUnread: false };
    await writeReleaseNotes({ organisation: "org" } as never, { projectId: "p1", userId: "u1" }, material, "customer");
    expect(m.gatewayWrite).toHaveBeenCalledWith(
      expect.anything(),
      { projectId: "p1", userId: "u1", source: "release_notes" },
      { model: "openai/gpt-6-luna", instructions: releaseNoteInstructions("customer"), data: material }
    );
  });
});
