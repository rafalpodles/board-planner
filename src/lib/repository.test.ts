import { describe, it, expect } from "vitest";
import { projectRepositoryUrl, repositoryCandidates, repositoryProvider } from "./repository";

describe("projectRepositoryUrl", () => {
  it("uses the repository URL when the project has one", () => {
    expect(projectRepositoryUrl({ repositoryUrl: "https://github.com/owner/repo" })).toBe(
      "https://github.com/owner/repo"
    );
  });

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

  it("does not classify a per-account ssh alias", () => {
    expect(repositoryProvider({ repositoryUrl: "git@github-work:owner/repo.git" })).toBe("");
  });

  it("treats a GitHub Enterprise subdomain as github", () => {
    expect(repositoryProvider({ repositoryUrl: "https://acme.github.com/owner/repo" })).toBe("github");
  });
});

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

  it("does not make a bare legacy value absolute, which would narrow what it matches", () => {
    expect(repositoryCandidates({ githubRepo: "owner/repo" })).toEqual(["owner/repo"]);
    expect(projectRepositoryUrl({ githubRepo: "owner/repo" })).toBe("https://github.com/owner/repo");
  });

  it("is empty for a project that names no repository", () => {
    expect(repositoryCandidates({})).toEqual([]);
  });
});
