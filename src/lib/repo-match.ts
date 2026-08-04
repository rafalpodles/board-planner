// One repository is reachable by many strings — ssh, https, with or without .git, and through a
// per-account ssh host alias like `git@github-rafalpodles:owner/repo.git`. Matching a worker's
// checkout to a project has to see through all of them, so both sides reduce to `owner/repo`.
const SSH_LIKE = /^[^/]+@[^/:]+:(.+)$/;
const SCHEMED = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^/]+\/(.+)$/i;

export function normaliseRemote(remote: unknown): string {
  if (typeof remote !== "string") return "";
  const trimmed = remote.trim();
  if (!trimmed) return "";

  const ssh = SSH_LIKE.exec(trimmed);
  const schemed = SCHEMED.exec(trimmed);
  let pathPart = ssh?.[1] ?? schemed?.[1] ?? trimmed;

  pathPart = pathPart.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  // A bare "owner/repo" from a project's githubRepo field arrives here too, and must survive intact
  return pathPart.toLowerCase();
}

export interface RepoReport {
  remote: string;
  path: string;
}

export interface MatchableProject {
  _id: unknown;
  githubRepo?: string;
  gitlabRepo?: string;
}

// A project can name its repository through either integration; a worker only knows the remote its
// checkout points at, so both are candidates for the same match.
export function projectRemotes(project: MatchableProject): string[] {
  return [project.githubRepo, project.gitlabRepo]
    .map(normaliseRemote)
    .filter((value) => value.length > 0);
}

// Returns the exact string the worker reported, never a path and never a normalised form: the
// worker resolves its own checkout from this, and it can only do that against what it sent.
export function matchRepo(project: MatchableProject, reported: RepoReport[]): string | null {
  const wanted = new Set(projectRemotes(project));
  if (wanted.size === 0) return null;

  for (const repo of reported) {
    if (wanted.has(normaliseRemote(repo.remote))) return repo.remote;
  }
  return null;
}
