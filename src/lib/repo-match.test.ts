import { describe, it, expect } from "vitest";
import { matchRepo, normaliseRemote, projectRemotes } from "./repo-match";

describe("normaliseRemote", () => {
  it("reduces every spelling of the same repository to one form", () => {
    const forms = [
      "git@github.com:rafalpodles/claude-planner.git",
      "git@github.com:rafalpodles/claude-planner",
      "https://github.com/rafalpodles/claude-planner.git",
      "https://github.com/rafalpodles/claude-planner",
      "ssh://git@github.com/rafalpodles/claude-planner.git",
      "rafalpodles/claude-planner",
    ];

    expect(new Set(forms.map(normaliseRemote))).toEqual(
      new Set(["rafalpodles/claude-planner"])
    );
  });

  // The remote this repository is actually cloned with. A per-account ssh alias is invisible to the
  // host it resolves to, so matching on the raw string would never fire.
  it("sees through a per-account ssh host alias", () => {
    expect(normaliseRemote("git@github-rafalpodles:rafalpodles/claude-planner.git")).toBe(
      "rafalpodles/claude-planner"
    );
  });

  it("keeps nested groups, which GitLab uses and GitHub does not", () => {
    expect(normaliseRemote("https://gitlab.com/group/subgroup/repo.git")).toBe(
      "group/subgroup/repo"
    );
  });

  it("ignores case, since hosts do", () => {
    expect(normaliseRemote("git@github.com:RafalPodles/Claude-Planner.git")).toBe(
      "rafalpodles/claude-planner"
    );
  });

  it("strips a https url's embedded credentials rather than matching on them", () => {
    expect(normaliseRemote("https://token@github.com/owner/repo.git")).toBe("owner/repo");
  });

  it("tolerates surrounding whitespace and trailing slashes", () => {
    expect(normaliseRemote("  https://github.com/owner/repo/  ")).toBe("owner/repo");
  });

  it("returns empty for anything unusable rather than throwing", () => {
    for (const bad of ["", "   ", null, undefined, 42, {}]) {
      expect(normaliseRemote(bad)).toBe("");
    }
  });
});

describe("projectRemotes", () => {
  it("offers both integrations as candidates", () => {
    const remotes = projectRemotes({
      _id: "p1",
      githubRepo: "owner/repo",
      gitlabRepo: "group/other",
    });

    expect(remotes).toEqual(["owner/repo", "group/other"]);
  });

  it("is empty for a project that names no repository", () => {
    expect(projectRemotes({ _id: "p1" })).toEqual([]);
  });
});

describe("matchRepo", () => {
  const project = { _id: "p1", githubRepo: "rafalpodles/claude-planner" };

  // Returns what the worker sent, not the normalised form: the worker looks its own checkout up by
  // this string, and only recognises the one it reported.
  it("answers with the exact string the worker reported", () => {
    const reported = [
      { remote: "git@github-rafalpodles:rafalpodles/claude-planner.git", path: "/a" },
    ];

    expect(matchRepo(project, reported)).toBe(
      "git@github-rafalpodles:rafalpodles/claude-planner.git"
    );
  });

  it("finds the match among unrelated checkouts", () => {
    const reported = [
      { remote: "git@github.com:someone/else.git", path: "/a" },
      { remote: "https://github.com/rafalpodles/claude-planner.git", path: "/b" },
    ];

    expect(matchRepo(project, reported)).toBe("https://github.com/rafalpodles/claude-planner.git");
  });

  it("is null when the worker has no checkout of this repository", () => {
    expect(matchRepo(project, [{ remote: "git@github.com:someone/else.git", path: "/a" }])).toBeNull();
  });

  // Without this a project naming no repository would match the first checkout on any machine
  it("is null for a project that names no repository, whatever the worker reports", () => {
    const reported = [{ remote: "git@github.com:anything/at-all.git", path: "/a" }];

    expect(matchRepo({ _id: "p1" }, reported)).toBeNull();
    expect(matchRepo({ _id: "p1", githubRepo: "" }, reported)).toBeNull();
  });

  it("is null when the worker reports nothing at all", () => {
    expect(matchRepo(project, [])).toBeNull();
  });

  // The operator decides which checkout wins by what they list first in repos.json — their machine,
  // their call — so the order they reported is the order honoured.
  it("takes the first reported checkout when a machine has two of the same repository", () => {
    const reported = [
      { remote: "git@github.com:rafalpodles/claude-planner.git", path: "/first" },
      { remote: "https://github.com/rafalpodles/claude-planner", path: "/second" },
    ];

    expect(matchRepo(project, reported)).toBe("git@github.com:rafalpodles/claude-planner.git");
  });

  it("matches through the gitlab field too", () => {
    const gitlab = { _id: "p1", gitlabRepo: "group/subgroup/repo" };
    const reported = [{ remote: "git@gitlab.com:group/subgroup/repo.git", path: "/a" }];

    expect(matchRepo(gitlab, reported)).toBe("git@gitlab.com:group/subgroup/repo.git");
  });
});
