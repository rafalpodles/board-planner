import { repositoryCandidates, RepositoryFields } from "./repository";

const SSH_LIKE = /^[^/]+@[^/:]+:(.+)$/;
const SCHEMED = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^/]+\/(.+)$/i;

export interface ParsedRemote {
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
  const host = rawHost.includes(".") ? rawHost.replace(/:\d+$/, "").toLowerCase() : "";

  return { host, repo: pathPart.toLowerCase() };
}

export function normaliseRemote(remote: unknown): string {
  return parseRemote(remote).repo;
}

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

export function projectRemotes(project: MatchableProject): string[] {
  return repositoryCandidates(project).filter((value) => normaliseRemote(value).length > 0);
}

export function matchRepo(project: MatchableProject, reported: RepoReport[]): string | null {
  const wanted = projectRemotes(project);
  if (wanted.length === 0) return null;

  for (const repo of reported) {
    if (wanted.some((candidate) => sameRepo(candidate, repo.remote))) return repo.remote;
  }
  return null;
}
