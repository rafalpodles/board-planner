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
