import { repositoryCandidates, repositoryUrlCandidates, RepositoryFields } from "./repository";

// One repository is reachable by many strings — ssh, https, with or without .git, and through a
// per-account ssh host alias like `git@github-owner:owner/repo.git`. Matching a worker's
// checkout to a project has to see through all of them, so both sides reduce to `owner/repo`.
const SSH_LIKE = /^[^/]+@[^/:]+:(.+)$/;
const SCHEMED = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^/]+\/(.+)$/i;

export interface ParsedRemote {
  // Empty when the string carries no real hostname — a bare "owner/repo", or an ssh alias like
  // `github-owner` that only this machine's ssh config can resolve.
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

/**
 * Whether a worker-supplied pull-request url names the project's own repository.
 *
 * The url is as attacker-controlled as the patch beside it — an agent can read the worker
 * credential off its own disk — and the shape check at the settle route only proves it is *a*
 * pull request somewhere. What is left is a well-formed link to a real host that is not this
 * project's, which is a phishing shape rather than an execution one (BP-604).
 *
 * Answered on the render side and never at settle time: a settlement the board refuses is retried
 * whole on the next poll, so a repository whose remote spelling differs from its pull request host
 * — a rename, a fork, GitHub Enterprise under another name — would strand real work behind a check
 * nobody can override from the panel. Here it costs a click and nothing else.
 *
 * A project that names no repository is not a mismatch: there is nothing to disagree with, and
 * this answers true so such a board reads exactly as it does today.
 */
export function prUrlNamesProjectRepo(prUrl: string, project: MatchableProject): boolean {
  // `repositoryUrlCandidates`, not `projectRemotes`: the latter hands out the legacy fields exactly
  // as stored, and a bare `owner/repo` has no host — which `sameRepo` reads as "matches any host",
  // deliberately, for matching a worker's checkout. Against a url a machine supplied that rule
  // says yes to every host, so this guard did not hold at all on a project that has not been
  // migrated to `repositoryUrl`: `https://evil.example.com/owner/repo/pull/1` rendered as a link
  // (found in review, measured on both legacy fields).
  const named = repositoryUrlCandidates(project).filter((url) => normaliseRemote(url).length > 0);
  if (named.length === 0) return true;
  if (!prUrl) return true;

  // Resolving the legacy fields is not enough on its own: `repositoryUrl` is stored as typed, and
  // two shapes it accepts carry no host either — a per-account ssh alias (`git@github-work:o/r`,
  // which only that machine's ssh config resolves) and a bare `owner/repo`, which the PATCH does
  // not refuse. Each left `sameRepo`'s any-host rule in place and the same phishing url passed
  // (found in the second review, measured). So a candidate with no host is not a candidate here,
  // and a project whose every candidate is one of those shapes can confirm nothing — the panel
  // prints the address rather than linking it, which is what its sentence says. Deliberately not
  // the same answer as "names no repository at all" above.
  const wanted = named.filter((url) => parseRemote(url).host.length > 0);
  if (wanted.length === 0) return false;

  // `/pull/123` and GitLab's `/-/merge_requests/123`, which is the shape the delivery step would
  // produce were GitLab delivery added — the repository is what precedes it.
  const repo = prUrl
    .replace(/\/(?:-\/)?(?:pull|merge_requests)\/\d+\/?$/, "")
    .replace(/\/+$/, "");
  if (repo === prUrl) return false;

  return wanted.some((candidate) => sameRepo(candidate, repo));
}
