import { allowLoopbackIn, escapeRegex, ParsedPR, projectKeyPattern, type TokenCheck } from "./github";
import { safeFetch, logUpstreamFailure, readBoundedJson, MAX_RESPONSE_BYTES } from "./safe-fetch";

export const GITLAB_DESTINATION = { allowLoopback: allowLoopbackIn() };

interface GitLabMR {
  iid: number;
  title: string;
  state: "opened" | "closed" | "merged" | "locked";
  web_url: string;
  merged_at: string | null;
  source_branch: string;
  updated_at: string;
}

/**
 * Before a token is stored: does GitLab take it, and can it read each project's merge requests. The
 * expiry comes from `/personal_access_tokens/self`, which a group or project token or an older GitLab
 * may not answer; then the token is stored with no expiry known.
 */
export async function checkGitlabToken(host: string, token: string, projectPaths: string[]): Promise<TokenCheck> {
  const base = host.replace(/\/+$/, "");
  const ask = (path: string) =>
    safeFetch(`${base}/api/v4${path}`, { headers: { "PRIVATE-TOKEN": token }, signal: AbortSignal.timeout(15000) }, GITLAB_DESTINATION);
  try {
    const user = await ask("/user");
    if (user.status === 401) return { ok: false, error: "GitLab rejected this token: it is wrong, expired or revoked. Nothing was saved." };
    if (!user.ok) return { ok: false, error: `GitLab answered ${user.status} when asked who this token belongs to. Nothing was saved.` };
    const { username } = (await readBoundedJson(user, MAX_RESPONSE_BYTES)) as { username?: string };

    let expiresAt: Date | null = null;
    const self = await ask("/personal_access_tokens/self");
    if (self.ok) {
      const { expires_at } = (await readBoundedJson(self, MAX_RESPONSE_BYTES)) as { expires_at?: string | null };
      expiresAt = parseGitlabExpiry(expires_at);
    } else {
      await self.body?.cancel().catch(() => undefined);
    }

    for (const path of projectPaths) {
      const project = await ask(`/projects/${encodeURIComponent(path)}`);
      await project.body?.cancel().catch(() => undefined);
      if (project.status === 404 || project.status === 403) {
        return { ok: false, error: `GitLab accepted this token, but it cannot read ${path}. Give it access to that project. Nothing was saved.` };
      }
      if (!project.ok) return { ok: false, error: `GitLab answered ${project.status} for ${path}. Nothing was saved.` };
      const requests = await ask(`/projects/${encodeURIComponent(path)}/merge_requests?per_page=1`);
      await requests.body?.cancel().catch(() => undefined);
      if (!requests.ok) {
        return { ok: false, error: `This token can see ${path} but not its merge requests. It needs the read_api scope. Nothing was saved.` };
      }
    }
    return { ok: true, login: username ?? "", expiresAt };
  } catch {
    return { ok: false, error: "GitLab could not be reached to check this token. Nothing was saved." };
  }
}

/** GitLab answers a day, `2027-01-24`; the token stops working at the start of it, in UTC. */
export function parseGitlabExpiry(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export async function fetchMergeRequests(
  host: string,
  projectPath: string,
  token: string
): Promise<GitLabMR[]> {
  const base = host.replace(/\/+$/, "");
  const url = `${base}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests?state=all&per_page=100&order_by=updated_at`;
  const res = await safeFetch(
    url,
    {
      headers: { "PRIVATE-TOKEN": token },
      signal: AbortSignal.timeout(15000),
    },
    GITLAB_DESTINATION
  );
  if (!res.ok) {
    await logUpstreamFailure("GitLab", res);
    throw new Error(`GitLab answered ${res.status}`);
  }
  return readBoundedJson(res, MAX_RESPONSE_BYTES);
}

const MERGED_PAGES = 5;

/** Every merge request merged since a day, newest activity first; `complete` is false past five pages */
export async function fetchMergedRequests(
  host: string,
  projectPath: string,
  token: string,
  since: Date
): Promise<{ requests: GitLabMR[]; complete: boolean }> {
  const base = host.replace(/\/+$/, "");
  const requests: GitLabMR[] = [];
  for (let page = 1; page <= MERGED_PAGES; page++) {
    const url = `${base}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests?state=merged&updated_after=${encodeURIComponent(since.toISOString())}&per_page=100&page=${page}`;
    const res = await safeFetch(url, { headers: { "PRIVATE-TOKEN": token }, signal: AbortSignal.timeout(15000) }, GITLAB_DESTINATION);
    if (!res.ok) {
      await logUpstreamFailure("GitLab", res);
      throw new Error(`GitLab answered ${res.status}`);
    }
    const batch = (await readBoundedJson(res, MAX_RESPONSE_BYTES)) as GitLabMR[];
    requests.push(...batch);
    if (batch.length < 100) return { requests, complete: true };
  }
  return { requests, complete: false };
}

// Same matching rules as GitHub PRs: project key + number in branch or title, and the keys the
// project used to have — renaming a project renames every task at once, while the branches and MR
// titles already on GitLab keep the prefix they were created with.
export function matchMRsToTasks(
  mrs: GitLabMR[],
  projectKey: string,
  formerKeys: string[] = []
): ParsedPR[] {
  const keys = [projectKey, ...formerKeys].filter(Boolean);
  const pattern = projectKeyPattern(keys);
  const results: ParsedPR[] = [];

  for (const mr of mrs) {
    const match = mr.source_branch.match(pattern) || mr.title.match(pattern);
    if (!match) continue;

    results.push({
      number: mr.iid,
      title: mr.title,
      state: mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed",
      url: mr.web_url,
      mergedAt: mr.merged_at ? new Date(mr.merged_at) : null,
      updatedAt: new Date(mr.updated_at),
      matchedTaskNumber: parseInt(match[1], 10),
      // GitLab pipelines are not read here, so no commit to attach checks to
      headSha: null,
    });
  }

  return results;
}

export interface TaskBranch {
  name: string;
  url: string;
  lastCommitAt: Date | null;
}

export interface TaskCommit {
  shortId: string;
  title: string;
  authorName: string;
  url: string;
  createdAt: Date | null;
}

interface GitLabBranch {
  name: string;
  web_url: string;
  commit?: { committed_date?: string };
}

interface GitLabCommitHit {
  id: string;
  short_id: string;
  title: string;
  message?: string;
  author_name: string;
  created_at: string;
}

function apiBase(host: string, projectPath: string): string {
  return `${host.replace(/\/+$/, "")}/api/v4/projects/${encodeURIComponent(projectPath)}`;
}

async function gitlabGet<T>(url: string, token: string): Promise<T> {
  const res = await safeFetch(
    url,
    {
      headers: { "PRIVATE-TOKEN": token },
      signal: AbortSignal.timeout(15000),
    },
    GITLAB_DESTINATION
  );
  if (!res.ok) {
    await logUpstreamFailure("GitLab", res);
    throw new Error(`GitLab answered ${res.status}`);
  }
  return readBoundedJson(res, MAX_RESPONSE_BYTES);
}

// Branch search on GitLab is case-sensitive, so the whole (capped) page is filtered
// locally with the same key pattern the MR matcher uses
export async function fetchTaskBranches(
  host: string,
  projectPath: string,
  token: string,
  taskKey: string
): Promise<TaskBranch[]> {
  const branches = await gitlabGet<GitLabBranch[]>(
    `${apiBase(host, projectPath)}/repository/branches?per_page=100`,
    token
  );
  const pattern = taskKeyPattern(taskKey);
  return branches
    .filter((b) => pattern.test(b.name))
    .map((b) => ({
      name: b.name,
      url: b.web_url,
      lastCommitAt: b.commit?.committed_date ? new Date(b.commit.committed_date) : null,
    }));
}

export async function fetchTaskCommits(
  host: string,
  projectPath: string,
  token: string,
  taskKey: string
): Promise<TaskCommit[]> {
  const hits = await gitlabGet<GitLabCommitHit[]>(
    `${apiBase(host, projectPath)}/search?scope=commits&search=${encodeURIComponent(taskKey)}`,
    token
  );
  // GitLab's search matches substrings, so "GL-3" also finds GL-30's commits
  const pattern = taskKeyPattern(taskKey);
  const webBase = `${host.replace(/\/+$/, "")}/${projectPath}/-/commit`;
  return hits
    .filter((c) => pattern.test(c.message ?? c.title))
    .map((c) => ({
      shortId: c.short_id,
      title: c.title,
      authorName: c.author_name,
      url: `${webBase}/${c.id}`,
      createdAt: c.created_at ? new Date(c.created_at) : null,
    }));
}

// "CP-5" also matches "cp-5/slug" and "CP 5". Split on the LAST hyphen so a
// hyphenated project key ("MY-PROJ-5") keeps its number instead of matching every branch.
//
// The lookbehind is the same boundary the shared pattern grew in BP-611: without it this listed
// `websucp-5` among CP-5's branches, for the same reason and with the same two-letter keys.
function taskKeyPattern(taskKey: string): RegExp {
  const separator = taskKey.lastIndexOf("-");
  const key = escapeRegex(taskKey.slice(0, separator));
  const number = taskKey.slice(separator + 1);
  return new RegExp(`(?<![A-Za-z0-9])${key}[- ]?${number}(?![0-9])`, "i");
}

// Accepts "group/project" or a full URL on the configured host
export function parseGitlabRepo(gitlabRepo: string): string | null {
  const trimmed = gitlabRepo.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const withoutOrigin = trimmed.replace(/^https?:\/\/[^/]+\//, "");
  return /^[\w.-]+(\/[\w.-]+)+$/.test(withoutOrigin) ? withoutOrigin : null;
}
