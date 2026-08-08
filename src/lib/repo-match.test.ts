import { describe, it, expect } from "vitest";
import { matchRepo, normaliseRemote, projectRemotes, sameRepo } from "./repo-match";

describe("normaliseRemote", () => {
  it("reduces every spelling of the same repository to one form", () => {
    const forms = [
      "git@github.com:rafalpodles/board-planner.git",
      "git@github.com:rafalpodles/board-planner",
      "https://github.com/rafalpodles/board-planner.git",
      "https://github.com/rafalpodles/board-planner",
      "ssh://git@github.com/rafalpodles/board-planner.git",
      "rafalpodles/board-planner",
    ];

    expect(new Set(forms.map(normaliseRemote))).toEqual(
      new Set(["rafalpodles/board-planner"])
    );
  });

  // The remote this repository is actually cloned with. A per-account ssh alias is invisible to the
  // host it resolves to, so matching on the raw string would never fire.
  it("sees through a per-account ssh host alias", () => {
    expect(normaliseRemote("git@github-rafalpodles:rafalpodles/board-planner.git")).toBe(
      "rafalpodles/board-planner"
    );
  });

  it("keeps nested groups, which GitLab uses and GitHub does not", () => {
    expect(normaliseRemote("https://gitlab.com/group/subgroup/repo.git")).toBe(
      "group/subgroup/repo"
    );
  });

  it("ignores case, since hosts do", () => {
    expect(normaliseRemote("git@github.com:RafalPodles/Board-Planner.git")).toBe(
      "rafalpodles/board-planner"
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
  const project = { _id: "p1", githubRepo: "rafalpodles/board-planner" };

  // Returns what the worker sent, not the normalised form: the worker looks its own checkout up by
  // this string, and only recognises the one it reported.
  it("answers with the exact string the worker reported", () => {
    const reported = [
      { remote: "git@github-rafalpodles:rafalpodles/board-planner.git", path: "/a" },
    ];

    expect(matchRepo(project, reported)).toBe(
      "git@github-rafalpodles:rafalpodles/board-planner.git"
    );
  });

  it("finds the match among unrelated checkouts", () => {
    const reported = [
      { remote: "git@github.com:someone/else.git", path: "/a" },
      { remote: "https://github.com/rafalpodles/board-planner.git", path: "/b" },
    ];

    expect(matchRepo(project, reported)).toBe("https://github.com/rafalpodles/board-planner.git");
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
      { remote: "git@github.com:rafalpodles/board-planner.git", path: "/first" },
      { remote: "https://github.com/rafalpodles/board-planner", path: "/second" },
    ];

    expect(matchRepo(project, reported)).toBe("git@github.com:rafalpodles/board-planner.git");
  });

  it("matches through the gitlab field too", () => {
    const gitlab = { _id: "p1", gitlabRepo: "group/subgroup/repo" };
    const reported = [{ remote: "git@gitlab.com:group/subgroup/repo.git", path: "/a" }];

    expect(matchRepo(gitlab, reported)).toBe("git@gitlab.com:group/subgroup/repo.git");
  });
});

// Dropping the host entirely made a self-hosted mirror, or a second account, match a project it has
// nothing to do with — and the agent would then run and push in the wrong checkout.
describe("hosts", () => {
  it("refuses two different real hosts holding the same owner/repo", () => {
    const project = { _id: "p1", githubRepo: "https://github.com/owner/repo" };
    const elsewhere = [{ remote: "git@git.internal.example.com:owner/repo.git", path: "/a" }];

    expect(matchRepo(project, elsewhere)).toBeNull();
  });

  it("still matches a bare owner/repo, which is what githubRepo actually holds", () => {
    const project = { _id: "p1", githubRepo: "owner/repo" };

    expect(matchRepo(project, [{ remote: "git@git.internal.example.com:owner/repo.git", path: "/a" }]))
      .toBe("git@git.internal.example.com:owner/repo.git");
  });

  // An ssh alias resolves through this machine's ssh config, so it is not a hostname to compare
  it("does not treat a per-account ssh alias as a host", () => {
    const project = { _id: "p1", githubRepo: "https://github.com/rafalpodles/board-planner" };
    const aliased = [{ remote: "git@github-rafalpodles:rafalpodles/board-planner.git", path: "/a" }];

    expect(matchRepo(project, aliased)).toBe(aliased[0].remote);
  });

  it("ignores a port when comparing hosts", () => {
    expect(sameRepo("ssh://git@gitlab.example.com:2222/owner/repo.git", "https://gitlab.example.com/owner/repo")).toBe(true);
  });

  it("matches the same real host spelled two ways", () => {
    expect(sameRepo("git@github.com:owner/repo.git", "https://github.com/owner/repo")).toBe(true);
  });
});

describe("a project migrated to one repository URL", () => {
  it("matches on the URL and ignores whatever the legacy fields still say", () => {
    const project = {
      _id: "p1",
      repositoryUrl: "https://github.com/owner/repo",
      githubRepo: "someone/else",
      gitlabRepo: "group/other",
    };

    expect(matchRepo(project, [{ remote: "git@github.com:owner/repo.git", path: "/r" }])).toBe(
      "git@github.com:owner/repo.git"
    );
    expect(matchRepo(project, [{ remote: "git@github.com:someone/else.git", path: "/r" }])).toBeNull();
  });

  it("offers exactly one candidate", () => {
    expect(
      projectRemotes({ _id: "p1", repositoryUrl: "https://gitlab.example.com/group/thing" })
    ).toEqual(["https://gitlab.example.com/group/thing"]);
  });
});
