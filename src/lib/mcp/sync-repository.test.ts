import { describe, it, expect } from "vitest";
import { syncProvider, syncSummary } from "./sync-repository";
import type { McpProject } from "./planner-client";

const board = (over: Partial<McpProject>): McpProject => ({
  _id: "p1",
  repositoryUrl: "https://github.com/example/board",
  repositoryProvider: "github",
  githubTokenSet: true,
  ...over,
});

describe("syncProvider", () => {
  it("picks the provider the board's repository is on", () => {
    expect(syncProvider(board({}), "bp")).toBe("github");
    expect(syncProvider(board({ repositoryProvider: "gitlab", gitlabTokenSet: true, githubTokenSet: false }), "bp")).toBe("gitlab");
  });

  it("refuses a board with no repository, saying where to set one", () => {
    expect(() => syncProvider(board({ repositoryUrl: "", repositoryProvider: "" }), "bp")).toThrow(
      /BP has no repository.*Settings → Integrations.*Nothing was synced/
    );
  });

  it("refuses a repository on neither provider", () => {
    expect(() => syncProvider(board({ repositoryUrl: "https://git.example.com/a/b", repositoryProvider: "" }), "bp")).toThrow(
      /neither on GitHub nor on GitLab/
    );
  });

  it("refuses a board with no token for the provider it is on, naming the provider", () => {
    expect(() => syncProvider(board({ githubTokenSet: false }), "bp")).toThrow(/no GitHub token stored/);
    expect(() =>
      syncProvider(board({ repositoryProvider: "gitlab", gitlabTokenSet: false, githubTokenSet: true }), "bp")
    ).toThrow(/no GitLab token stored/);
  });

  it("never repeats the repository's address, which can carry credentials", () => {
    const secret = "https://user:hunter2@git.example.com/a/b";
    for (const project of [board({ repositoryUrl: secret, repositoryProvider: "" }), board({ repositoryUrl: secret, githubTokenSet: false })]) {
      try {
        syncProvider(project, "bp");
      } catch (error) {
        expect((error as Error).message).not.toContain("hunter2");
        expect((error as Error).message).not.toContain("git.example.com");
      }
    }
  });
});

describe("syncSummary", () => {
  it("says what was refreshed, in the provider's own word", () => {
    expect(syncSummary("github", { prsFound: 3, tasksLinked: 2, prsLinked: 3, prsUnlinked: 0, autoTransitioned: 0 })).toEqual({
      provider: "github",
      synced: true,
      matched: 3,
      linksRefreshed: 3,
      tasksLinked: 2,
      linksRemoved: 0,
      tasksMoved: 0,
      summary: "Refreshed 3 pull requests on 2 tasks.",
    });
    expect(syncSummary("gitlab", { prsFound: 1, tasksLinked: 1, prsLinked: 1 }).summary).toBe("Refreshed 1 merge request on 1 task.");
  });

  it("says what else happened: stale links removed, tasks moved on", () => {
    expect(syncSummary("github", { prsFound: 2, tasksLinked: 2, prsLinked: 2, prsUnlinked: 1, autoTransitioned: 1 }).summary).toBe(
      "Refreshed 2 pull requests on 2 tasks; 1 stale link removed; 1 task moved to the next review column because its pull request merged."
    );
  });

  it("says why nothing was refreshed when no request names a task", () => {
    expect(syncSummary("github", { prsFound: 0 }).summary).toBe(
      "No pull request names a task of this board (in its branch or title), so there was nothing to refresh."
    );
  });
});
