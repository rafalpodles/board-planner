import { escapeRegex } from "./escape-regex";
import { MAX_RESPONSE_BYTES, readBoundedJson, readBoundedText, safeFetch } from "@/lib/safe-fetch";

/**
 * Every GitHub call goes through `safeFetch`, which re-checks the destination at each redirect hop
 * and refuses a private address — the same guard `gitlab.ts` has always used.
 *
 * It was not needed while the host was the literal `api.github.com`, and making that injectable is
 * what removed the reason: an operator with a typo, or a corporate proxy, now decides where a
 * project's token is sent. The loopback carve-out is the one `pm/mcp-client.ts` already makes, on the
 * same condition — it is what lets `e2e/github-stub.mjs` be reachable at all, and production
 * refuses it.
 */
export const allowLoopbackIn = (env = process.env.NODE_ENV) => env !== "production";
export const GITHUB_DESTINATION = { allowLoopback: allowLoopbackIn() };

interface GitHubPR {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  merged_at: string | null;
  head: { ref: string; sha?: string };
  updated_at: string;
}

// Injectable for the same reason OPENROUTER_BASE_URL is: with api.github.com written into the URL
// the sync was the one integration no browser test could drive, so `e2e/seed.ts` planted its
// results by hand instead. Read per call, never per project — an operator sets where GitHub is,
// and a project naming its own host would be a request forgery with a token attached.
const API_BASE = () => process.env.GITHUB_API_BASE_URL || "https://api.github.com";

/**
 * What continuous integration says about a pull request's head commit.
 *
 * `unknown` is not a state GitHub reports: it is what this instance says when it has not read the
 * checks — because the request failed, or because the pull request was past the cap and nobody
 * asked. Distinct from `none` on purpose: "nothing has run" and "we have not looked" send a reader
 * to different places, and collapsing them is how an instance that cannot reach GitHub reads as a
 * board where no build ever ran.
 *
 * Narrower than it sounds, and worth saying so: a token so broken that the pull-request listing
 * fails never reaches this state at all, because the sync throws before any link is written and
 * the badges keep whatever the last good sync stored.
 */
export type CiState = "none" | "running" | "success" | "failure" | "unknown";

export interface PullRequestChecks {
  ci: CiState;
  /** The check that decided the state, for the badge's tooltip. */
  ciLabel: string | null;
}

interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  completed_at?: string | null;
}

interface CommitStatus {
  state: "success" | "pending" | "failure" | "error" | string;
  statuses: { context: string; state: string }[];
}

// A conclusion that means the commit did not pass. `cancelled` and `timed_out` belong here rather
// than with the neutral ones: GitHub's own merge box blocks on them, and a build somebody stopped
// is not a build that succeeded.
const FAILING = new Set(["failure", "timed_out", "action_required", "cancelled", "startup_failure"]);
// Ran, decided nothing, blocks nothing. A workflow whose every job was skipped is the ordinary
// case here — a path filter that did not match — and reading that as a failure would paint most
// documentation pull requests red.
const NEUTRAL = new Set(["neutral", "skipped", "stale"]);

// A key stored before BP-401 constrained the format may still be one like "C(", which must not
// blow up the matcher
export { escapeRegex };

export interface ParsedPR {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  url: string;
  mergedAt: Date | null;
  updatedAt: Date;
  matchedTaskNumber: number;
  /** The head commit, which is what checks are attached to. Absent on a pull request GitHub answered without one. */
  headSha: string | null;
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
    fetchPage(`${API_BASE()}/repos/${owner}/${repo}/pulls?state=open&per_page=100`, headers),
    fetchPage(
      `${API_BASE()}/repos/${owner}/${repo}/pulls?state=closed&per_page=30&sort=updated&direction=desc`,
      headers
    ),
  ]);

  return [...openPRs, ...closedPRs];
}

async function fetchPage(url: string, headers: Record<string, string>): Promise<GitHubPR[]> {
  const res = await safeFetch(
    url,
    { headers, signal: AbortSignal.timeout(15000) },
    GITHUB_DESTINATION
  );
  if (!res.ok) throw await refusal(res);
  return readBoundedJson(res, MAX_RESPONSE_BYTES);
}

/**
 * What GitHub said, as an error a person may be shown.
 *
 * The status and nothing else. The body used to travel in the message and the message now reaches
 * a toast — and the body is written by whatever host `GITHUB_API_BASE_URL` names, which is handed
 * an `Authorization` header. A server that echoes its request would put the project's token on
 * somebody's screen. It goes to the log, which is where a diagnosis belongs.
 *
 * A rate limit is named rather than left as "403", because it is the one refusal where the answer
 * is to wait rather than to check the token.
 */
async function refusal(res: Response, perCommit = false): Promise<Error> {
  // Bounded, not `res.text()`: a host answering an error with a multi-gigabyte body would exhaust
  // the container while being politely refused, and nothing in the log would look like an attack
  // (BP-317, which is why `readBoundedText` exists).
  const body = await readBoundedText(res, 4096).catch(() => "");
  // `warn` for a per-commit call: a repository where one of the two check endpoints refuses
  // systematically produces a line per pull request per tick — up to 240 an hour on one project —
  // and drowning the log is its own outage. The pull-request listing keeps `error`, because it
  // fails once per sync and takes the whole sync down with it.
  (perCommit ? console.warn : console.error)(`GitHub API ${res.status}: ${body.slice(0, 500)}`);

  const limited = rateLimit(res);
  // "account", not "token": the limit is counted per GitHub account, so the branch that burnt it
  // is often a different board using the same person's credential. Saying "this token" sends the
  // reader to check the one in front of them, which is the mistake CLAUDE.md was corrected for.
  if (limited) return new Error(`GitHub rate limit reached for this GitHub account; ${limited}`);
  return new Error(`GitHub answered ${res.status}`);
}

/**
 * Whether this refusal is a rate limit, and when to come back — or `null` if it is something else.
 *
 * Three shapes, not one. GitHub answers a **primary** limit with 403 or 429 and
 * `x-ratelimit-remaining: 0`, and a **secondary** limit with 403 or 429, a `retry-after` in
 * seconds, and a remaining count that is often **not** zero. Keying on 403-with-zero-remaining
 * alone — which is what this did — sent the other two into "GitHub answered 403", the message that
 * tells a reader to go and check their token. Waiting is the answer to all three.
 */
function rateLimit(res: Response): string | null {
  if (res.status !== 403 && res.status !== 429) return null;

  // `retry-after` is seconds **or** an HTTP date (RFC 9110). GitHub sends seconds, but
  // GITHUB_API_BASE_URL may name a corporate proxy that does not — and "wait Wed, 21 Oct 2015
  // 07:28:00 GMTs" is not a sentence.
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    return /^\d+$/.test(retryAfter.trim())
      ? `wait ${retryAfter.trim()}s before retrying`
      : `retry after ${retryAfter}`;
  }

  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const resets = res.headers.get("x-ratelimit-reset");
    return resets
      ? `it resets at ${new Date(Number(resets) * 1000).toISOString()}`
      : "it resets shortly";
  }
  return null;
}

/**
 * Match PRs to task numbers by scanning branch name and PR title.
 * Pattern: project key (case-insensitive) followed by - and number.
 * E.g. "cp-5/some-slug" or "CP-5 add feature" → task number 5.
 */
export function matchPRsToTasks(
  prs: GitHubPR[],
  projectKey: string,
  formerKeys: string[] = []
): ParsedPR[] {
  // Former keys count: a task key is built from the project's current key, so renaming it
  // renames every task at once — while the branches and PR titles already on GitHub keep
  // the prefix they were created with, and would otherwise all stop matching.
  const keys = [projectKey, ...formerKeys].filter(Boolean);
  const pattern = new RegExp(`(?:${keys.map(escapeRegex).join("|")})[- ](\\d+)`, "i");

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
      headSha: pr.head.sha ?? null,
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

/**
 * Reduces everything continuous integration has said about one commit to a single state.
 *
 * Two mechanisms, because GitHub has two and a repository may use either: check runs (Actions and
 * most apps) and the older commit statuses (`statuses` API — what a great many external CI services
 * still post). Ignoring the second would paint a passing build grey on any repository using it.
 *
 * Failure outranks running, which is the one ordering choice here worth stating: once a job has
 * failed the answer is already known, and a badge that keeps spinning until the last unrelated job
 * finishes is a badge that tells somebody to wait for news that has arrived.
 */
export function reduceChecks(
  runs: CheckRun[],
  status: CommitStatus | null
): PullRequestChecks {
  const failed = runs.find((run) => run.conclusion !== null && FAILING.has(run.conclusion));
  if (failed) return { ci: "failure", ciLabel: failed.name };
  if (status && (status.state === "failure" || status.state === "error")) {
    const context = status.statuses.find((s) => s.state === "failure" || s.state === "error");
    return { ci: "failure", ciLabel: context?.context ?? null };
  }

  const pending = runs.find((run) => run.status !== "completed");
  if (pending) return { ci: "running", ciLabel: pending.name };
  if (status?.state === "pending") {
    const context = status.statuses.find((s) => s.state === "pending");
    // A pending commit status with no contexts is what GitHub answers for a commit nothing has
    // posted about at all, so there is nothing running and nothing to name.
    if (context) return { ci: "running", ciLabel: context.context };
  }

  if (runs.length === 0 && (!status || status.statuses.length === 0)) {
    return { ci: "none", ciLabel: null };
  }

  // Everything that ran is finished and none of it failed. The label names the one that finished
  // last, which is the check a reader is most likely to be waiting on; a run that reports no
  // `completed_at` sorts to the bottom rather than winning on an empty string.
  const decided = [...runs]
    .filter((run) => run.conclusion !== null && !NEUTRAL.has(run.conclusion))
    .sort((a, b) => (a.completed_at ?? "").localeCompare(b.completed_at ?? ""))
    .at(-1);
  // Falling through to the other mechanism rather than leaving the tooltip empty: a repository
  // posting commit statuses and no check runs has a name for what passed, and it is the only name
  // it has.
  const context = status?.statuses.find((s) => s.state === "success");
  return { ci: "success", ciLabel: decided?.name ?? context?.context ?? null };
}

/**
 * What CI says about one commit, or `unknown` when GitHub could not be asked.
 *
 * Swallowed rather than thrown: the pull request's own state is worth storing even when the checks
 * could not be read, and a sync that gave up here would take the link, the title and the merge
 * state down with it.
 */
export async function fetchChecks(
  owner: string,
  repo: string,
  sha: string,
  token: string
): Promise<PullRequestChecks> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
  };
  const base = `${API_BASE()}/repos/${owner}/${repo}/commits/${sha}`;

  // Settled, not all: the two mechanisms are independent, and `Promise.all` threw the good half
  // away with the bad — a commit whose check runs had been read perfectly well answered `unknown`
  // because the commit-status call, which its repository does not even use, returned an error.
  //
  // The premise the first version of this comment gave for that was wrong, and it is worth
  // correcting rather than deleting: a repository using only one mechanism does **not** get an
  // error from the other. Both answer 200 and empty — `/status` with `{state: "pending", statuses:
  // []}` and `/check-runs` with `{total_count: 0, check_runs: []}`, which is what this branch's own
  // stub encodes as NOTHING_RAN. So a rejection almost always means auth, a rate limit or the
  // network, and that is exactly when half an answer must not be read as a whole one.
  const [runs, status] = await Promise.allSettled([
    fetchCheckRuns(base, headers),
    fetchJson<CommitStatus>(`${base}/status`, headers),
  ]);

  const checks = runs.status === "fulfilled" ? runs.value : { runs: [], complete: false };
  const wholeStory = checks.complete && status.status === "fulfilled";
  const reduced = reduceChecks(
    checks.runs,
    status.status === "fulfilled" ? status.value : null
  );

  // One rule where there were two special cases, and it is the only one that survives thinking
  // about what a partial read can and cannot establish.
  //
  // **A failure seen is a failure**, however much went unread: nothing on an unread page can
  // un-fail a job we watched fail, so this is trusted even from half the evidence.
  //
  // **Anything else needs the whole story.** `none` is the claim "nothing has run" and `success`
  // the claim "nothing failed" — and the failure that would refute either is exactly what an
  // unread page or an unanswered endpoint might hold. The version of this that guarded only
  // `none` reported a **green tick on a commit whose failing check run it had already read and
  // then discarded**, when a mid-pagination refusal threw page one away with page two and the
  // commit-status endpoint happened to be green. That is the mirror of the bug paging was added
  // for, and worse, because the evidence had been collected before being dropped.
  if (reduced.ci === "failure") return reduced;
  return wholeStory ? reduced : { ci: "unknown", ciLabel: null };
}

/** Pages a commit can have before this stops reading them. */
export const MAX_CHECK_RUN_PAGES = 3;

/**
 * Every check run on a commit, not only the first hundred.
 *
 * A matrix build puts more than a hundred runs on one commit easily, and a page is not ordered by
 * outcome — so reading only the first would let a failing job on page two be reported as a pass,
 * which is the one answer this whole feature must not get wrong. Bounded at three pages: past
 * three hundred runs the cost of being sure is worse than the imprecision.
 *
 * `complete` says whether the whole story was read — every page, and none of them refused. A short
 * read is not an error and not nothing: what was read is kept, because a failure in it is still a
 * failure, and `fetchChecks` refuses to draw any *other* conclusion from it.
 */
async function fetchCheckRuns(
  base: string,
  headers: Record<string, string>
): Promise<{ runs: CheckRun[]; complete: boolean }> {
  const runs: CheckRun[] = [];
  for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page++) {
    let answer: { total_count?: number; check_runs?: CheckRun[] };
    try {
      answer = await fetchJson<{ total_count?: number; check_runs?: CheckRun[] }>(
        `${base}/check-runs?per_page=100&page=${page}`,
        headers
      );
    } catch {
      // What was read is kept and flagged short. Letting this reject threw away pages already in
      // hand — including, in the case that matters, a page carrying the failure.
      return { runs, complete: false };
    }
    const batch = answer.check_runs ?? [];
    runs.push(...batch);
    // `?? Infinity`, not `?? runs.length`: the fallback used to make the right-hand side
    // `runs.length >= runs.length`, always true, so a host that does not send `total_count`
    // silently turned paging off after page one — and this branch's own stub is such a host, so
    // no test could reach page two through it. `batch.length < 100` is the sufficient condition;
    // `total_count` only ever saves a wasted request, it must never end the loop early.
    if (batch.length < 100 || runs.length >= (answer.total_count ?? Infinity)) {
      return { runs, complete: true };
    }
  }
  // Out of pages with a full one behind us: there may be more, and saying so is what stops a
  // three-hundred-run commit reporting a pass it has not earned.
  return { runs, complete: false };
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await safeFetch(
    url,
    { headers, signal: AbortSignal.timeout(15000) },
    GITHUB_DESTINATION
  );
  if (!res.ok) throw await refusal(res, true);
  return readBoundedJson(res, MAX_RESPONSE_BYTES);
}

/**
 * How many open pull requests one sync will ask GitHub about.
 *
 * Each one costs two to four requests — one commit-status call plus up to `MAX_CHECK_RUN_PAGES`
 * pages of check runs — and a busy board syncing every five minutes would otherwise scale its bill
 * with the number of open branches. The most recently updated are asked about first, so what the
 * cap drops is the stalest.
 */
export const MAX_CHECKED_PULL_REQUESTS = 20;
export const CHECK_CONCURRENCY = 5;

/**
 * Attaches CI state to matched pull requests.
 *
 * A pull request that is merged or closed is never asked about: its build is history, the badge
 * shows the merge rather than the checks, and not asking is both the rate-limit answer and the
 * "stop polling what has finished" one. Anything past the cap is `unknown` for the honest reason —
 * nobody asked.
 */
export async function withChecks(
  prs: ParsedPR[],
  owner: string,
  repo: string,
  token: string,
  /**
   * A task number whose pull requests are asked about whatever the cap says.
   *
   * The cap starves the same pull requests on every tick, deterministically — and a manual Refresh
   * runs the same capped sync, so on a board with more than `MAX_CHECKED_PULL_REQUESTS` open pull
   * requests a person had no way to force a look at the one in front of them. This is that way.
   * It is itself capped, so the worst a Refresh can cost is twice an ordinary sync.
   */
  alwaysAsk?: number
): Promise<(ParsedPR & PullRequestChecks)[]> {
  const open = prs.filter((pr) => pr.state === "open" && pr.headSha);
  // Capped like everything else. The comment here used to say "bounded by construction: a task has
  // a handful at most" — which is not a bound, it is an expectation about data GitHub supplies. A
  // hundred branches all titled `BP-5 …` would have made one Refresh click four hundred requests.
  const insisted =
    alwaysAsk === undefined
      ? []
      : open
          .filter((pr) => pr.matchedTaskNumber === alwaysAsk)
          .slice(0, MAX_CHECKED_PULL_REQUESTS);
  const askable = [
    ...insisted,
    ...open
      .filter((pr) => !insisted.includes(pr))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, MAX_CHECKED_PULL_REQUESTS),
  ];

  const checks = new Map<ParsedPR, PullRequestChecks>();
  for (let i = 0; i < askable.length; i += CHECK_CONCURRENCY) {
    const batch = askable.slice(i, i + CHECK_CONCURRENCY);
    const answers = await Promise.all(
      batch.map((pr) => fetchChecks(owner, repo, pr.headSha as string, token))
    );
    batch.forEach((pr, index) => checks.set(pr, answers[index]));
  }

  // An open pull request nobody asked about — past the cap, or with no head commit to ask about —
  // is `unknown` rather than `none`: nobody looked, which is not the same as nothing having run.
  // `carryForward` in github-sync.ts keeps a previous outcome where there is one, so this reaches
  // the screen for a pull request nobody has asked about yet — and for one whose head has moved
  // since, because an answer about the old commit is not an answer about this one.
  return prs.map((pr) => ({
    ...pr,
    ...(checks.get(pr) ?? {
      ci: pr.state === "open" ? ("unknown" as const) : ("none" as const),
      ciLabel: null,
    }),
  }));
}
