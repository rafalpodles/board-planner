import { repositoryCandidates, RepositoryFields } from "./repository";

// One repository is reachable by many strings — ssh, https, with or without .git, and through a
// per-account ssh host alias like `git@github-rafalpodles:owner/repo.git`. Matching a worker's
// checkout to a project has to see through all of them, so both sides reduce to `owner/repo`.
const SSH_LIKE = /^[^/]+@[^/:]+:(.+)$/;
const SCHEMED = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^/]+\/(.+)$/i;

export interface ParsedRemote {
  // Empty when the string carries no real hostname — a bare "owner/repo", or an ssh alias like
  // `github-rafalpodles` that only this machine's ssh config can resolve.
  host: string;
  repo: string;
}

const SSH_HOST = /^[^/]+@([^/:]+):/;
const SCHEMED_HOST = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/]+)\//i;

export function parseRemote(remote: unknown): ParsedRemote {
  if (typeof remote !== "string") return { host: "", repo: "" };
  const trimmed = remote.trim();
  if (!trimmed) return { host: "", repo: "" };

  const ssh = SSH_LIKE.exec(trimmed);
  const schemed = SCHEMED.exec(trimmed);
  const pathPart = (ssh?.[1] ?? schemed?.[1] ?? trimmed)
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");

  const rawHost = SSH_HOST.exec(trimmed)?.[1] ?? SCHEMED_HOST.exec(trimmed)?.[1] ?? "";
  // A dot is what separates a real hostname from a per-account ssh alias. An alias is invisible to
  // the host it resolves to, so treating it as one would stop the match firing at all.
  const host = rawHost.includes(".") ? rawHost.replace(/:\d+$/, "").toLowerCase() : "";

  return { host, repo: pathPart.toLowerCase() };
}

export function normaliseRemote(remote: unknown): string {
  return parseRemote(remote).repo;
}

// Two strings name the same repository when the paths agree AND their hosts do not disagree. A
// bare "owner/repo" — which is what a project's githubRepo field holds — has no host to compare,
// so it still matches; two different real hosts holding "owner/repo" no longer collide.
export function sameRepo(a: unknown, b: unknown): boolean {
  const left = parseRemote(a);
  const right = parseRemote(b);
  if (!left.repo || left.repo !== right.repo) return false;
  return !left.host || !right.host || left.host === right.host;
}

export interface RepoReport {
  remote: string;
  path: string;
}

export interface MatchableProject extends RepositoryFields {
  _id: unknown;
}

// One candidate once a project has been migrated to repositoryUrl; until then, both legacy fields
// exactly as they were stored — see repositoryCandidates for why they are not normalised first.
export function projectRemotes(project: MatchableProject): string[] {
  return repositoryCandidates(project).filter((value) => normaliseRemote(value).length > 0);
}

// Returns the exact string the worker reported, never a path and never a normalised form: the
// worker resolves its own checkout from this, and it can only do that against what it sent.
export function matchRepo(project: MatchableProject, reported: RepoReport[]): string | null {
  const wanted = projectRemotes(project);
  if (wanted.length === 0) return null;

  for (const repo of reported) {
    if (wanted.some((candidate) => sameRepo(candidate, repo.remote))) return repo.remote;
  }
  return null;
}
