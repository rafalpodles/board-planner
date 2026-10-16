import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  histories: vi.fn(),
  fetchPullRequests: vi.fn(),
  gatewayWrite: vi.fn(),
}));

vi.mock("@/lib/status-history", () => ({ projectStatusHistories: m.histories }));
vi.mock("@/lib/github", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/github")>()), fetchPullRequests: m.fetchPullRequests }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: () => "token" }));
vi.mock("@/lib/ai-gateway", () => ({ gatewayWrite: m.gatewayWrite }));
vi.mock("@/lib/pm/availability", () => ({ resolveAiModel: async () => "openai/gpt-6-luna" }));

const { releaseMaterial, isEmpty, releaseNoteInstructions, writeReleaseNotes } = await import("./release-notes");

const WINDOW = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-14T23:59:59.999Z"), label: "Sprint 7" };

const history = (taskNumber: number, finishedAt: string | null, role = "done", archived = false) => ({
  taskId: `t${taskNumber}`,
  taskNumber,
  title: `Task ${taskNumber}`,
  category: taskNumber % 2 ? "bug" : "user-story",
  role,
  archived,
  history: { kind: "recorded", finishedAt: finishedAt ? new Date(finishedAt) : null },
});

function fakeDb(project: Record<string, unknown> = {}) {
  const lean = <T>(value: T) => ({ lean: async () => value });
  return {
    organisation: "org",
    Project: { findById: () => lean({ key: "TP", ...project }) },
    Task: {
      find: () =>
        lean([
          { _id: "t1", description: "Fixed the export", linkedPRs: [{ title: "Fix export", url: "https://github.com/o/r/pull/1", mergedAt: new Date("2026-10-02") }, { title: "Draft", url: "u2", mergedAt: null }] },
          { _id: "t2", description: "", linkedPRs: [] },
        ]),
    },
  } as never;
}

beforeEach(() => Object.values(m).forEach((fn) => fn.mockReset()));

describe("releaseMaterial", () => {
  it("takes the tasks that reached a done column in the window, with their merged pull requests", async () => {
    m.histories.mockResolvedValue([
      history(1, "2026-10-03T10:00:00Z"),
      history(2, "2026-10-14T23:00:00Z"),
      history(3, "2026-09-30T23:59:59Z"),
      history(4, "2026-10-05T00:00:00Z", "active"),
      history(5, "2026-10-05T00:00:00Z", "done", true),
      history(6, null),
    ]);
    const material = await releaseMaterial(fakeDb(), "p1", WINDOW);
    expect(material!.tasks).toEqual([
      { key: "TP-1", title: "Task 1", category: "bug", description: "Fixed the export", pullRequests: [{ title: "Fix export", url: "https://github.com/o/r/pull/1", mergedAt: "2026-10-02T00:00:00.000Z" }] },
      { key: "TP-2", title: "Task 2", category: "user-story", description: "", pullRequests: [] },
    ]);
    expect(material!.pullRequestsWithoutTask).toEqual([]);
    expect(m.fetchPullRequests).not.toHaveBeenCalled();
  });

  it("adds the repository's merges in the window that no task claims", async () => {
    m.histories.mockResolvedValue([]);
    m.fetchPullRequests.mockResolvedValue([
      { number: 7, title: "Bump deps", html_url: "https://github.com/o/r/pull/7", merged_at: "2026-10-04T00:00:00Z", state: "closed", head: { ref: "deps" } },
      { number: 8, title: "TP-1 export", html_url: "https://github.com/o/r/pull/8", merged_at: "2026-10-04T00:00:00Z", state: "closed", head: { ref: "tp-1" } },
      { number: 9, title: "Old", html_url: "https://github.com/o/r/pull/9", merged_at: "2026-09-01T00:00:00Z", state: "closed", head: { ref: "old" } },
      { number: 10, title: "Open", html_url: "https://github.com/o/r/pull/10", merged_at: null, state: "open", head: { ref: "x" } },
    ]);
    const material = await releaseMaterial(fakeDb({ repositoryUrl: "https://github.com/o/r", githubToken: "sealed" }), "p1", WINDOW);
    expect(material!.pullRequestsWithoutTask).toEqual([{ title: "Bump deps", url: "https://github.com/o/r/pull/7", mergedAt: "2026-10-04T00:00:00Z" }]);
    expect(isEmpty(material!)).toBe(false);
  });

  it("still covers the tasks when the repository cannot be read, and says so", async () => {
    m.histories.mockResolvedValue([history(1, "2026-10-03T10:00:00Z")]);
    m.fetchPullRequests.mockRejectedValue(new Error("GitHub answered 401"));
    const material = await releaseMaterial(fakeDb({ repositoryUrl: "https://github.com/o/r", githubToken: "sealed" }), "p1", WINDOW);
    expect(material!.tasks).toHaveLength(1);
    expect(material!.repositoryUnread).toBe("GitHub answered 401");
  });

  it("calls a window with nothing in it empty", async () => {
    m.histories.mockResolvedValue([history(3, "2026-09-30T00:00:00Z")]);
    expect(isEmpty((await releaseMaterial(fakeDb(), "p1", WINDOW))!)).toBe(true);
  });
});

describe("writing the notes", () => {
  it("asks for every item once, grouped by category, inventing nothing, in the tone chosen", () => {
    expect(releaseNoteInstructions("changelog")).toMatch(/developers[^]*heading per category[^]*Other changes[^]*every task and every pull request given, once, and nothing that is not given/);
    expect(releaseNoteInstructions("customer")).toMatch(/customers/);
  });

  it("goes through the gateway as release notes, with the material as data", async () => {
    m.gatewayWrite.mockResolvedValue({ ok: true, text: "## Bug\n- x" });
    const material = { window: { from: "a", to: "b", label: "S" }, tasks: [], pullRequestsWithoutTask: [], repositoryUnread: null };
    await writeReleaseNotes({ organisation: "org" } as never, { projectId: "p1", userId: "u1" }, material, "customer");
    expect(m.gatewayWrite).toHaveBeenCalledWith(expect.anything(), { projectId: "p1", userId: "u1", source: "release_notes" }, { model: "openai/gpt-6-luna", instructions: releaseNoteInstructions("customer"), data: material });
  });
});
