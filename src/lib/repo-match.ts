import {
  entryId,
  repositoryProvider,
  repositoryCandidates,
  repositoryUrlCandidates,
  storedRepositories,
  type RepositoryEntry,
  type RepositoryFields,
} from "./repository";

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
  repositories?: RepositoryEntry[] | null;
}

// Every address the project names: its stored repositories once it has any, otherwise one candidate
// once a project has been migrated to repositoryUrl, or both legacy fields exactly as they were
// stored — see repositoryCandidates for why they are not normalised first.
export function projectRemotes(project: MatchableProject): string[] {
  const entries = storedRepositories(project).map((r) => r.url);
  const wanted = entries.length > 0 ? entries : repositoryCandidates(project);
  return wanted.filter((value) => normaliseRemote(value).length > 0);
}

export interface ServedRepository {
  // Null for a project that has no stored list yet, whose single repository has no id to name
  id: string | null;
  remote: string;
}

/**
 * The first repository of this project, in the project's own order, that a machine holds a checkout
 * of, and the remote it reported for it. It answers "does this machine serve the project at all" for
 * the screens that ask that; a project that lists several repositories is claimed only with every one
 * of them (`repositoryCoverage`).
 */
export function servedRepository(project: MatchableProject, reported: RepoReport[]): ServedRepository | null {
  const entries = storedRepositories(project).filter((r) => normaliseRemote(r.url).length > 0);
  if (entries.length === 0) {
    const wanted = projectRemotes(project);
    for (const repo of reported) {
      if (wanted.some((candidate) => sameRepo(candidate, repo.remote))) return { id: null, remote: repo.remote };
    }
    return null;
  }
  for (const entry of entries) {
    const hit = reported.find((repo) => sameRepo(entry.url, repo.remote));
    if (hit) return { id: entryId(entry), remote: hit.remote };
  }
  return null;
}

export interface HeldRepository {
  id: string;
  name: string;
  remote: string;
}

export interface MissingRepository {
  id: string;
  name: string;
}

/**
 * Which of the project's repositories a machine holds a checkout of, entry by entry in the project's
 * order. An entry resolves to at most ONE reported checkout and a checkout serves at most one entry:
 * matching is fuzzy (`sameRepo` lets a bare `owner/repo` match any host), so two entries that read as
 * the same repository would otherwise be bound to one checkout and run in the same working tree twice.
 * The second of them is reported as missing, which is the safe answer.
 *
 * A project with no stored list has one repository and no ids to name; it has no coverage to judge.
 */
export function repositoryCoverage(
  project: MatchableProject,
  reported: RepoReport[]
): { held: HeldRepository[]; missing: MissingRepository[] } {
  const held: HeldRepository[] = [];
  const missing: MissingRepository[] = [];
  const taken = new Set<number>();

  for (const entry of storedRepositories(project)) {
    const name = (entry.name?.trim() || entry.url.trim()).slice(0, 200);
    const at = reported.findIndex((r, i) => !taken.has(i) && sameRepo(entry.url, r.remote));
    if (at < 0) {
      missing.push({ id: entryId(entry), name });
      continue;
    }
    taken.add(at);
    held.push({ id: entryId(entry), name, remote: reported[at].remote });
  }
  return { held, missing };
}

// Returns the exact string the worker reported, never a path and never a normalised form: the
// worker resolves its own checkout from this, and it can only do that against what it sent.
export function matchRepo(project: MatchableProject, reported: RepoReport[]): string | null {
  return servedRepository(project, reported)?.remote ?? null;
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

/**
 * The repositories of one provider that a project lists several of, in order: what a sync reads. A
 * project that lists one has its one, whatever the provider says — the sync names that case in its own
 * words — so callers look at `storedRepositories` first.
 */
export function repositoriesOfProvider(project: RepositoryFields, provider: "github" | "gitlab"): string[] {
  const urls = storedRepositories(project)
    .map((r) => r.url.trim())
    .filter((url) => repositoryProvider({ repositoryUrl: url, gitlabHost: project.gitlabHost }) === provider);
  // One round for a repository however many entries spell it, or the spend and the counts double
  return urls.filter((url, at) => {
    const mine = parseRemote(url);
    return urls.findIndex((other) => {
      const theirs = parseRemote(other);
      return theirs.repo === mine.repo && theirs.host === mine.host;
    }) === at;
  });
}
