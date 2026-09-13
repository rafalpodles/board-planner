import { describe, it, expect, afterEach, vi } from "vitest";
import {
  matchRepo,
  normaliseRemote,
  projectRemotes,
  prUrlNamesProjectRepo,
  sameRepo,
} from "./repo-match";

describe("normaliseRemote", () => {
  it("reduces every spelling of the same repository to one form", () => {
    const forms = [
      "git@github.com:owner/board-planner.git",
      "git@github.com:owner/board-planner",
      "https://github.com/owner/board-planner.git",
      "https://github.com/owner/board-planner",
      "ssh://git@github.com/owner/board-planner.git",
      "owner/board-planner",
    ];

    expect(new Set(forms.map(normaliseRemote))).toEqual(
      new Set(["owner/board-planner"])
    );
  });

  // The remote this repository is actually cloned with. A per-account ssh alias is invisible to the
  // host it resolves to, so matching on the raw string would never fire.
  it("sees through a per-account ssh host alias", () => {
    expect(normaliseRemote("git@github-owner:owner/board-planner.git")).toBe(
      "owner/board-planner"
    );
  });

  it("keeps nested groups, which GitLab uses and GitHub does not", () => {
    expect(normaliseRemote("https://gitlab.com/group/subgroup/repo.git")).toBe(
      "group/subgroup/repo"
    );
  });

  it("ignores case, since hosts do", () => {
    expect(normaliseRemote("git@github.com:OwnerName/Board-Planner.git")).toBe(
      "ownername/board-planner"
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
  const project = { _id: "p1", githubRepo: "owner/board-planner" };

  // Returns what the worker sent, not the normalised form: the worker looks its own checkout up by
  // this string, and only recognises the one it reported.
  it("answers with the exact string the worker reported", () => {
    const reported = [
      { remote: "git@github-owner:owner/board-planner.git", path: "/a" },
    ];

    expect(matchRepo(project, reported)).toBe(
      "git@github-owner:owner/board-planner.git"
    );
  });

  it("finds the match among unrelated checkouts", () => {
    const reported = [
      { remote: "git@github.com:someone/else.git", path: "/a" },
      { remote: "https://github.com/owner/board-planner.git", path: "/b" },
    ];

    expect(matchRepo(project, reported)).toBe("https://github.com/owner/board-planner.git");
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
      { remote: "git@github.com:owner/board-planner.git", path: "/first" },
      { remote: "https://github.com/owner/board-planner", path: "/second" },
    ];

    expect(matchRepo(project, reported)).toBe("git@github.com:owner/board-planner.git");
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
    const project = { _id: "p1", githubRepo: "https://github.com/owner/board-planner" };
    const aliased = [{ remote: "git@github-owner:owner/board-planner.git", path: "/a" }];

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

/**
 * BP-604. A settlement is never refused by this — the check is on the render side, so a rename, a
 * fork or GitHub Enterprise under another name costs a click rather than stranding real work
 * behind a verdict nobody can override from the panel.
 */
describe("prUrlNamesProjectRepo", () => {
  const project = (over: Record<string, unknown> = {}) => ({
    _id: "p1",
    repositoryUrl: "https://github.com/owner/repo",
    ...over,
  });

  it("accepts the project's own repository, however the project spells it", () => {
    expect(prUrlNamesProjectRepo("https://github.com/owner/repo/pull/42", project())).toBe(true);
    expect(
      prUrlNamesProjectRepo(
        "https://github.com/owner/repo/pull/42",
        project({ repositoryUrl: "git@github.com:owner/repo.git" })
      )
    ).toBe(true);
  });

  it("refuses a well-formed url naming somebody else's repository", () => {
    expect(prUrlNamesProjectRepo("https://github.com/attacker/repo/pull/1", project())).toBe(false);
  });

  it("refuses the same path on a different host", () => {
    expect(prUrlNamesProjectRepo("https://evil.example.com/owner/repo/pull/1", project())).toBe(
      false
    );
  });

  it("leaves a project that names no repository exactly as it is", () => {
    expect(prUrlNamesProjectRepo("https://github.com/o/r/pull/1", { _id: "p1" })).toBe(true);
  });

  it("says nothing about a url with no pull request in it", () => {
    // Nothing the settle route accepts looks like this; if one ever arrives, the panel's own
    // unreadable branch is the right home for it and a link is not.
    expect(prUrlNamesProjectRepo("https://github.com/owner/repo", project())).toBe(false);
  });

  it("reads GitLab's merge request shape too", () => {
    expect(
      prUrlNamesProjectRepo(
        "https://gitlab.com/group/thing/-/merge_requests/3",
        project({ repositoryUrl: "https://gitlab.com/group/thing" })
      )
    ).toBe(true);
  });

  /**
   * The shape the guard did not cover, measured by two reviewers independently: a project still on
   * the legacy `githubRepo`/`gitlabRepo` fields. `projectRemotes` hands those out as stored, and a
   * bare `owner/repo` has no host — which `sameRepo` treats as matching any host. So every url in
   * this block used to answer `true` and render as a clickable link.
   */
  it("holds on a project that has not been migrated to repositoryUrl", () => {
    const legacy = { _id: "p1", githubRepo: "owner/repo" };

    expect(prUrlNamesProjectRepo("https://evil.example.com/owner/repo/pull/1", legacy)).toBe(false);
    expect(prUrlNamesProjectRepo("http://evil.internal/owner/repo/pull/1", legacy)).toBe(false);
    // And the machine's own pull request still is one: a legacy githubRepo is GitHub's by
    // definition, which is how `projectRepositoryUrl` has always resolved it.
    expect(prUrlNamesProjectRepo("https://github.com/owner/repo/pull/42", legacy)).toBe(true);
  });

  it("holds on a legacy GitLab project, against the host it had to configure anyway", () => {
    const legacy = {
      _id: "p1",
      gitlabRepo: "group/proj",
      gitlabHost: "https://gitlab.example.com",
    };

    expect(
      prUrlNamesProjectRepo("http://evil.internal/group/proj/-/merge_requests/2", legacy)
    ).toBe(false);
    expect(
      prUrlNamesProjectRepo("https://gitlab.example.com/group/proj/-/merge_requests/2", legacy)
    ).toBe(true);
  });

  // A project carrying both legacy fields names two repositories, and a pull request from either
  // is its own.
  it("offers both legacy fields when a project has both", () => {
    const both = { _id: "p1", githubRepo: "owner/repo", gitlabRepo: "group/proj" };

    expect(prUrlNamesProjectRepo("https://github.com/owner/repo/pull/1", both)).toBe(true);
    expect(prUrlNamesProjectRepo("https://gitlab.com/group/proj/-/merge_requests/1", both)).toBe(true);
    expect(prUrlNamesProjectRepo("https://evil.example.com/owner/repo/pull/1", both)).toBe(false);
  });

  // The second review's finding: resolving the legacy fields left the same hole open for the two
  // shapes `repositoryUrl` itself accepts without a host. Both measured as `true` before this.
  it("confirms nothing for a project whose repository is a per-account ssh alias", () => {
    const aliased = { _id: "p1", repositoryUrl: "git@github-work:owner/repo.git" };

    expect(prUrlNamesProjectRepo("https://evil.example.com/owner/repo/pull/1", aliased)).toBe(false);
    // Not even its own, and that is the trade: only that machine's ssh config knows what
    // `github-work` resolves to, so there is no host here to agree with
    expect(prUrlNamesProjectRepo("https://github.com/owner/repo/pull/1", aliased)).toBe(false);
  });

  it("confirms nothing for a bare owner/repo typed into repositoryUrl", () => {
    const bare = { _id: "p1", repositoryUrl: "owner/repo" };

    expect(prUrlNamesProjectRepo("https://evil.example.com/owner/repo/pull/1", bare)).toBe(false);
  });

  // The distinction the branch above must not flatten: a board naming no repository at all has
  // nothing to disagree with, and reads exactly as it did before BP-604.
  it("still says yes for a project that names no repository", () => {
    expect(prUrlNamesProjectRepo("https://github.com/owner/repo/pull/1", { _id: "p1" })).toBe(true);
  });

  it("is not fooled by a repository whose name ends in the project's", () => {
    expect(prUrlNamesProjectRepo("https://github.com/owner/repo-fork/pull/1", project())).toBe(
      false
    );
  });
});

// BP-634: the guard judges by host, so on a GitHub Enterprise instance an unmigrated project used
// to confirm nothing — the corporate pull request was printed as text rather than linked.
describe("prUrlNamesProjectRepo on an instance whose GitHub is not github.com", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a pull request on the corporate host, and still refuses every other one", () => {
    vi.stubEnv("GITHUB_API_BASE_URL", "https://ghe.corp.example/api/v3");
    const project = { _id: "p1", githubRepo: "owner/repo" };

    expect(prUrlNamesProjectRepo("https://ghe.corp.example/owner/repo/pull/7", project)).toBe(true);
    expect(prUrlNamesProjectRepo("https://evil.example.com/owner/repo/pull/7", project)).toBe(false);
    // github.com is now the other host, and fails closed like any other
    expect(prUrlNamesProjectRepo("https://github.com/owner/repo/pull/7", project)).toBe(false);
  });
});
