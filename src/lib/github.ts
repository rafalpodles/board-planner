interface GitHubPR {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  merged_at: string | null;
  head: { ref: string };
  updated_at: string;
}

export interface ParsedPR {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  url: string;
  mergedAt: Date | null;
  updatedAt: Date;
  matchedTaskNumber: number;
}

/**
 * Fetch PRs from GitHub API (open + recently closed).
 */
export async function fetchPullRequests(
  owner: string,
  repo: string,
  token: string
): Promise<GitHubPR[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
  };

  const [openPRs, closedPRs] = await Promise.all([
    fetchPage(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100`, headers),
    fetchPage(`https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&per_page=30&sort=updated&direction=desc`, headers),
  ]);

  return [...openPRs, ...closedPRs];
}

async function fetchPage(url: string, headers: Record<string, string>): Promise<GitHubPR[]> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }
  return res.json();
}

/**
 * Match PRs to task numbers by scanning branch name and PR title.
 * Pattern: project key (case-insensitive) followed by - and number.
 * E.g. "cp-5/some-slug" or "CP-5 add feature" → task number 5.
 */
export function matchPRsToTasks(
  prs: GitHubPR[],
  projectKey: string
): ParsedPR[] {
  const pattern = new RegExp(`${projectKey}[- ](\\d+)`, "i");

  const results: ParsedPR[] = [];

  for (const pr of prs) {
    // Try branch name first, then title
    const branchMatch = pr.head.ref.match(pattern);
    const titleMatch = pr.title.match(pattern);
    const match = branchMatch || titleMatch;

    if (!match) continue;

    const taskNumber = parseInt(match[1], 10);
    results.push({
      number: pr.number,
      title: pr.title,
      state: pr.merged_at ? "merged" : pr.state,
      url: pr.html_url,
      mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
      updatedAt: new Date(pr.updated_at),
      matchedTaskNumber: taskNumber,
    });
  }

  return results;
}

/**
 * Parse "owner/repo" from githubRepo string.
 */
export function parseRepoString(githubRepo: string): { owner: string; repo: string } | null {
  // Accept "owner/repo" or "https://github.com/owner/repo"
  const match = githubRepo.match(/(?:github\.com\/)?([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}
