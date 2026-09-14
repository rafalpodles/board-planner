// A project names its repository once, as a URL, whoever hosts it. `githubRepo` and `gitlabRepo`
// are still read as a fallback so the app works against a database the migration has not run on
// yet — see scripts/migrate-repository-url.ts.

import { githubWebBase } from "./github-host";

export type RepositoryProvider = "github" | "gitlab" | "";

export interface RepositoryFields {
  repositoryUrl?: string;
  githubRepo?: string;
  gitlabRepo?: string;
  gitlabHost?: string;
}

const SSH_HOST = /^[^/]+@([^/:]+):/;
const SCHEMED_HOST = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/]+)/i;
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^/]+@[^/:]+:)/i;

/**
 * The host a repository string names, for every spelling the field accepts: an ssh remote, any
 * scheme (`https://`, `ssh://`, `git://`), with or without userinfo.
 *
 * Empty for anything with no real hostname in it — a bare `owner/repo`, or a per-account ssh alias
 * like `github-work`, which only that machine's ssh config can resolve.
 *
 * Exported because a second reader of the same field wrote its own `^https?://` test and let every
 * other spelling through, which is how a private Enterprise path reached github.com (BP-634
 * review). One rule, or the two disagree about the same string.
 */
export function hostOf(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  const raw = SSH_HOST.exec(trimmed)?.[1] ?? SCHEMED_HOST.exec(trimmed)?.[1] ?? "";
  return raw.includes(".") ? raw.toLowerCase() : "";
}

/** The host without the port, which is how every caller compares one. */
export function bareHost(host: string): string {
  return host.replace(/:\d+$/, "");
}

function absolute(value: string, base: string): string {
  if (ABSOLUTE.test(value)) return value;
  return `${base.replace(/\/+$/, "")}/${value.replace(/^\/+/, "")}`;
}

// Matching wants the strings exactly as they were stored, which is not what provider derivation
// wants. A legacy `githubRepo` of "owner/repo" carries no host, and sameRepo treats that as
// "matches any host" — deliberately, because it is how a project pointing at a self-hosted git
// ever matched a worker at all. Making it absolute for the provider's sake would silently narrow
// that to github.com and strand every task on such a project, so matching keeps the raw values
// until the migration has replaced them with one real URL.
export function repositoryCandidates(project: RepositoryFields): string[] {
  const explicit = project.repositoryUrl?.trim();
  if (explicit) return [explicit];
  return [project.githubRepo?.trim() ?? "", project.gitlabRepo?.trim() ?? ""].filter(Boolean);
}

/**
 * Every repository this project names, each one carrying a host.
 *
 * `repositoryCandidates` deliberately does not: it feeds `sameRepo`, where a bare `owner/repo`
 * must match any host, because that is the only way a project pointing at a self-hosted git ever
 * matched a worker's checkout. That rule is right for matching a machine and wrong for judging a
 * url somebody else supplied — a hostless candidate makes every host correct, which is how
 * BP-604's guard came to pass `evil.example.com/owner/repo/pull/1` on a project still on the
 * legacy fields (found in review).
 *
 * So the legacy fields are resolved the way `projectRepositoryUrl` resolves them — `githubRepo` is
 * GitHub's by definition, `gitlabRepo` belongs to the host the project already had to configure
 * for its API calls to work — and both are offered, because a project can carry both.
 */
export function repositoryUrlCandidates(project: RepositoryFields): string[] {
  const explicit = project.repositoryUrl?.trim();
  if (explicit) return [explicit];

  const github = project.githubRepo?.trim();
  const gitlab = project.gitlabRepo?.trim();
  return [
    github ? absolute(github, githubWebBase()) : "",
    gitlab ? absolute(gitlab, project.gitlabHost?.trim() || "https://gitlab.com") : "",
  ].filter(Boolean);
}

export function projectRepositoryUrl(project: RepositoryFields): string {
  const explicit = project.repositoryUrl?.trim();
  if (explicit) return explicit;

  // Not the literal github.com: an instance pointed at GitHub Enterprise reads its pull requests
  // from the corporate host, and a legacy `githubRepo` resolved to github.com is a link to a
  // repository somebody else owns — and, through `repositoryProvider` below, a sync that refuses
  // to run (BP-634).
  const github = project.githubRepo?.trim();
  if (github) return absolute(github, githubWebBase());

  const gitlab = project.gitlabRepo?.trim();
  if (gitlab) return absolute(gitlab, project.gitlabHost?.trim() || "https://gitlab.com");

  return "";
}

// Derived from the host rather than from a column, so one field can serve every provider. The
// self-hosted GitLab case has no telling hostname, and needs the hint the project already carries:
// gitlabHost, without which none of its API calls could have worked in the first place.
export function repositoryProvider(project: RepositoryFields): RepositoryProvider {
  const host = hostOf(projectRepositoryUrl(project));
  if (!host) return "";

  const bare = bareHost(host);
  if (bare === "github.com" || bare.endsWith(".github.com")) return "github";
  if (bare === "gitlab.com" || bare.endsWith(".gitlab.com")) return "gitlab";

  const configured = hostOf(project.gitlabHost);
  if (configured && configured === host) return "gitlab";

  // This instance's own GitHub, when it is not github.com. Last, so a project that went to the
  // trouble of naming a self-hosted GitLab keeps it even if the two hosts somehow coincide: a
  // per-project hint beats an instance-wide default.
  const instance = hostOf(githubWebBase());
  if (instance && instance === host) return "github";

  return "";
}
