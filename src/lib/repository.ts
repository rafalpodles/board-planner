// A project names its repository once, as a URL, whoever hosts it. `githubRepo` and `gitlabRepo`
// are still read as a fallback so the app works against a database the migration has not run on
// yet — see scripts/migrate-repository-url.ts.

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

// Empty for anything with no real hostname in it — a bare `owner/repo`, or a per-account ssh alias
// like `github-work`, which only that machine's ssh config can resolve.
function hostOf(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  const raw = SSH_HOST.exec(trimmed)?.[1] ?? SCHEMED_HOST.exec(trimmed)?.[1] ?? "";
  return raw.includes(".") ? raw.toLowerCase() : "";
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

export function projectRepositoryUrl(project: RepositoryFields): string {
  const explicit = project.repositoryUrl?.trim();
  if (explicit) return explicit;

  const github = project.githubRepo?.trim();
  if (github) return absolute(github, "https://github.com");

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

  const bare = host.replace(/:\d+$/, "");
  if (bare === "github.com" || bare.endsWith(".github.com")) return "github";
  if (bare === "gitlab.com" || bare.endsWith(".gitlab.com")) return "gitlab";

  const configured = hostOf(project.gitlabHost);
  if (configured && configured === host) return "gitlab";

  return "";
}
