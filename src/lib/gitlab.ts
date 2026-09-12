import { escapeRegex, ParsedPR } from "./github";
import { safeFetch, logUpstreamFailure, readBoundedJson, MAX_RESPONSE_BYTES } from "./safe-fetch";

interface GitLabMR {
  iid: number;
  title: string;
  state: "opened" | "closed" | "merged" | "locked";
  web_url: string;
  merged_at: string | null;
  source_branch: string;
  updated_at: string;
}

export async function fetchMergeRequests(
  host: string,
  projectPath: string,
  token: string
): Promise<GitLabMR[]> {
  const base = host.replace(/\/+$/, "");
  const url = `${base}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests?state=all&per_page=100&order_by=updated_at`;
  const res = await safeFetch(url, {
    headers: { "PRIVATE-TOKEN": token },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    await logUpstreamFailure("GitLab", res);
    throw new Error(`GitLab API `);
  }
  return readBoundedJson(res, MAX_RESPONSE_BYTES);
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
  const pattern = new RegExp(`(?:${keys.map(escapeRegex).join("|")})[- ](\\d+)`, "i");
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
  author_name: string;
  created_at: string;
}

function apiBase(host: string, projectPath: string): string {
  return `${host.replace(/\/+$/, "")}/api/v4/projects/${encodeURIComponent(projectPath)}`;
}

async function gitlabGet<T>(url: string, token: string): Promise<T> {
  const res = await safeFetch(url, {
    headers: { "PRIVATE-TOKEN": token },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    await logUpstreamFailure("GitLab", res);
    throw new Error(`GitLab API `);
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
  const webBase = `${host.replace(/\/+$/, "")}/${projectPath}/-/commit`;
  return hits.map((c) => ({
    shortId: c.short_id,
    title: c.title,
    authorName: c.author_name,
    url: `${webBase}/${c.id}`,
    createdAt: c.created_at ? new Date(c.created_at) : null,
  }));
}

// "CP-5" also matches "cp-5/slug" and "CP 5". Split on the LAST hyphen so a
// hyphenated project key ("MY-PROJ-5") keeps its number instead of matching every branch.
function taskKeyPattern(taskKey: string): RegExp {
  const separator = taskKey.lastIndexOf("-");
  const key = escapeRegex(taskKey.slice(0, separator));
  const number = taskKey.slice(separator + 1);
  return new RegExp(`${key}[- ]?${number}(?![0-9])`, "i");
}

// Accepts "group/project" or a full URL on the configured host
export function parseGitlabRepo(gitlabRepo: string): string | null {
  const trimmed = gitlabRepo.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const withoutOrigin = trimmed.replace(/^https?:\/\/[^/]+\//, "");
  return /^[\w.-]+(\/[\w.-]+)+$/.test(withoutOrigin) ? withoutOrigin : null;
}
