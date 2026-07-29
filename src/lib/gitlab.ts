import { ParsedPR } from "./github";

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
  const res = await fetch(url, {
    headers: { "PRIVATE-TOKEN": token },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`GitLab API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  return res.json();
}

// Same matching rules as GitHub PRs: project key + number in branch or title
export function matchMRsToTasks(mrs: GitLabMR[], projectKey: string): ParsedPR[] {
  const pattern = new RegExp(`${projectKey}[- ](\\d+)`, "i");
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

// Accepts "group/project" or a full URL on the configured host
export function parseGitlabRepo(gitlabRepo: string): string | null {
  const trimmed = gitlabRepo.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  const withoutOrigin = trimmed.replace(/^https?:\/\/[^/]+\//, "");
  return /^[\w.-]+(\/[\w.-]+)+$/.test(withoutOrigin) ? withoutOrigin : null;
}
