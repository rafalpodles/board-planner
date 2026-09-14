import { describe, it, expect, afterEach, vi } from "vitest";
import {
  projectRepositoryUrl,
  repositoryCandidates,
  repositoryProvider,
  repositoryUrlCandidates,
} from "./repository";

describe("projectRepositoryUrl", () => {
  it("uses the repository URL when the project has one", () => {
    expect(projectRepositoryUrl({ repositoryUrl: "https://github.com/owner/repo" })).toBe(
      "https://github.com/owner/repo"
    );
  });

  // The fallback is what lets the app deploy before the migration has run
  it("falls back to the legacy GitHub field, made absolute", () => {
    expect(projectRepositoryUrl({ githubRepo: "owner/repo" })).toBe("https://github.com/owner/repo");
  });

  it("leaves a legacy GitHub field that was already a URL alone", () => {
    expect(projectRepositoryUrl({ githubRepo: "https://github.com/owner/repo" })).toBe(
      "https://github.com/owner/repo"
    );
  });

  it("joins the legacy GitLab field onto the host that project configured", () => {
    expect(
      projectRepositoryUrl({ gitlabRepo: "group/thing", gitlabHost: "https://gitlab.example.com" })
    ).toBe("https://gitlab.example.com/group/thing");
  });

  it("assumes gitlab.com for a legacy GitLab field with no host set", () => {
    expect(projectRepositoryUrl({ gitlabRepo: "group/thing" })).toBe("https://gitlab.com/group/thing");
  });

  it("prefers the new field over either legacy one", () => {
    expect(
      projectRepositoryUrl({
        repositoryUrl: "https://git.example.com/a/b",
        githubRepo: "owner/repo",
        gitlabRepo: "group/thing",
      })
    ).toBe("https://git.example.com/a/b");
  });

  it("prefers GitHub over GitLab when only the legacy fields are set", () => {
    expect(projectRepositoryUrl({ githubRepo: "owner/repo", gitlabRepo: "group/thing" })).toBe(
      "https://github.com/owner/repo"
    );
  });

  it("is empty for a project that names no repository", () => {
    expect(projectRepositoryUrl({})).toBe("");
    expect(projectRepositoryUrl({ repositoryUrl: "   " })).toBe("");
  });

  it("keeps an ssh remote as it was written", () => {
    expect(projectRepositoryUrl({ repositoryUrl: "git@github.com:owner/repo.git" })).toBe(
      "git@github.com:owner/repo.git"
    );
  });
});

describe("repositoryProvider", () => {
  it("recognises github.com over https and over ssh", () => {
    expect(repositoryProvider({ repositoryUrl: "https://github.com/owner/repo" })).toBe("github");
    expect(repositoryProvider({ repositoryUrl: "git@github.com:owner/repo.git" })).toBe("github");
  });

  it("recognises gitlab.com", () => {
    expect(repositoryProvider({ repositoryUrl: "https://gitlab.com/group/thing" })).toBe("gitlab");
  });

  // The case the task flagged: a self-hosted GitLab has neither github.com nor gitlab.com in its
  // host, so the host alone cannot classify it. gitlabHost is the hint, and it already exists —
  // every GitLab API call goes to ${gitlabHost}/api/v4, so a self-hosted project must already set it.
  it("recognises a self-hosted GitLab through the host that project already configured", () => {
    expect(
      repositoryProvider({
        repositoryUrl: "https://git.company.internal/group/thing",
        gitlabHost: "https://git.company.internal",
      })
    ).toBe("gitlab");
  });

  it("recognises a self-hosted GitLab on a port", () => {
    expect(
      repositoryProvider({
        repositoryUrl: "https://git.company.internal:8443/group/thing",
        gitlabHost: "https://git.company.internal:8443",
      })
    ).toBe("gitlab");
  });

  it("does not call a host GitLab just because some other project self-hosts", () => {
    expect(
      repositoryProvider({
        repositoryUrl: "https://bitbucket.org/team/thing",
        gitlabHost: "https://git.company.internal",
      })
    ).toBe("");
  });

  it("leaves an unknown host unclassified rather than guessing", () => {
    expect(repositoryProvider({ repositoryUrl: "https://bitbucket.org/team/thing" })).toBe("");
    expect(repositoryProvider({ repositoryUrl: "https://git.sr.ht/~user/thing" })).toBe("");
  });

  it("classifies a project still on the legacy fields", () => {
    expect(repositoryProvider({ githubRepo: "owner/repo" })).toBe("github");
    expect(repositoryProvider({ gitlabRepo: "group/thing", gitlabHost: "https://gitlab.example.com" })).toBe(
      "gitlab"
    );
  });

  it("is unclassified for a project with no repository at all", () => {
    expect(repositoryProvider({})).toBe("");
  });

  // An ssh host alias resolves only through that machine's ssh config, so nothing here can know
  // what it points at
  it("does not classify a per-account ssh alias", () => {
    expect(repositoryProvider({ repositoryUrl: "git@github-work:owner/repo.git" })).toBe("");
  });

  it("treats a GitHub Enterprise subdomain as github", () => {
    expect(repositoryProvider({ repositoryUrl: "https://acme.github.com/owner/repo" })).toBe("github");
  });
});

// Matching and provider derivation want different things out of the same fields, and conflating
// them is how a project on a self-hosted git quietly stops being matched to its worker.
describe("repositoryCandidates", () => {
  it("offers the one URL once a project has been migrated", () => {
    expect(
      repositoryCandidates({
        repositoryUrl: "https://github.com/owner/repo",
        githubRepo: "owner/repo",
        gitlabRepo: "group/thing",
      })
    ).toEqual(["https://github.com/owner/repo"]);
  });

  it("offers both legacy fields, exactly as stored, until then", () => {
    expect(repositoryCandidates({ githubRepo: "owner/repo", gitlabRepo: "group/thing" })).toEqual([
      "owner/repo",
      "group/thing",
    ]);
  });

  // The regression this guards: a bare owner/repo has no host, which sameRepo reads as "any host".
  // Making it absolute for the provider's benefit would narrow it to github.com and strand every
  // task on a project whose repository is actually somewhere else.
  it("does not make a bare legacy value absolute, which would narrow what it matches", () => {
    expect(repositoryCandidates({ githubRepo: "owner/repo" })).toEqual(["owner/repo"]);
    expect(projectRepositoryUrl({ githubRepo: "owner/repo" })).toBe("https://github.com/owner/repo");
  });

  it("is empty for a project that names no repository", () => {
    expect(repositoryCandidates({})).toEqual([]);
  });
});

/**
 * BP-634. The legacy fields were resolved against the literal github.com while the API calls went
 * to `GITHUB_API_BASE_URL`, so on a GitHub Enterprise instance every unmigrated project named a
 * repository on somebody else's host — and `repositoryProvider`, which classifies by host, then
 * had to answer `""` for the corporate one, which is both sync routes refusing to run.
 */
describe("an instance whose GitHub is not github.com", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const enterprise = () => vi.stubEnv("GITHUB_API_BASE_URL", "https://ghe.corp.example/api/v3");

  it("resolves a legacy GitHub field to the corporate host", () => {
    enterprise();
    expect(projectRepositoryUrl({ githubRepo: "owner/repo" })).toBe(
      "https://ghe.corp.example/owner/repo"
    );
    expect(repositoryUrlCandidates({ githubRepo: "owner/repo" })).toEqual([
      "https://ghe.corp.example/owner/repo",
    ]);
  });

  it("still calls the corporate host GitHub", () => {
    enterprise();
    expect(repositoryProvider({ githubRepo: "owner/repo" })).toBe("github");
    // And for a project the migration has already reached, which was refused outright before
    expect(repositoryProvider({ repositoryUrl: "https://ghe.corp.example/owner/repo" })).toBe(
      "github"
    );
  });

  // The project-specific hint wins over the instance-wide one, so a board that went to the trouble
  // of naming a self-hosted GitLab keeps it
  it("does not take a self-hosted GitLab that happens to share the host", () => {
    enterprise();
    expect(
      repositoryProvider({
        repositoryUrl: "https://ghe.corp.example/group/thing",
        gitlabHost: "https://ghe.corp.example",
      })
    ).toBe("gitlab");
  });

  it("leaves every other host alone", () => {
    enterprise();
    expect(repositoryProvider({ repositoryUrl: "https://evil.example.com/owner/repo" })).toBe("");
  });

  it("changes nothing on a github.com instance", () => {
    vi.stubEnv("GITHUB_API_BASE_URL", "");
    expect(projectRepositoryUrl({ githubRepo: "owner/repo" })).toBe("https://github.com/owner/repo");
    expect(repositoryUrlCandidates({ githubRepo: "owner/repo" })).toEqual([
      "https://github.com/owner/repo",
    ]);
    expect(repositoryProvider({ githubRepo: "owner/repo" })).toBe("github");
  });

  // The durable fix for all of this is the migration: once the field carries a real url, the
  // instance's host has no say in it at all
  it("does not touch a project that names its repository outright", () => {
    enterprise();
    expect(projectRepositoryUrl({ repositoryUrl: "https://github.com/owner/repo" })).toBe(
      "https://github.com/owner/repo"
    );
  });
});
