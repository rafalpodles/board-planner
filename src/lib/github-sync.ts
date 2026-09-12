import type { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { decryptSecret } from "@/lib/encryption";
import { fetchPullRequests, matchPRsToTasks, parseRepoString, withChecks } from "@/lib/github";
import { logActivity } from "@/lib/activity";
import { getProjectColumns } from "@/lib/columns";
import { writeProviderLinks } from "@/lib/pr-links";
import { projectRepositoryUrl, repositoryProvider } from "@/lib/repository";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import type { RepositoryFields } from "@/lib/repository";
import type { CiState, ILinkedPR, IProjectColumn } from "@/types";

/**
 * What a sync needs to know about a project — no more, so a `.lean()` projection satisfies it and
 * the scheduler does not have to read whole documents to call this.
 */
export type SyncableProject = RepositoryFields & {
  _id: Types.ObjectId | string;
  key: string;
  formerKeys?: string[] | null;
  githubToken?: string | null;
  columns?: IProjectColumn[] | null;
};

const DEFAULT_TICK_MS = 5 * 60 * 1000;

/**
 * How often the background sync runs. `0` turns it off — the switch an operator has when a token
 * is rate-limited elsewhere.
 *
 * A value that is not a number falls back to the default and says so, rather than reading as `NaN`
 * and silently never starting: an instance where the operator typed `5m` would otherwise be
 * indistinguishable from one where the sync is working.
 */
export function syncTickMs(raw = process.env.GITHUB_SYNC_TICK_MS): number {
  if (raw === undefined || raw === "") return DEFAULT_TICK_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `GITHUB_SYNC_TICK_MS="${raw}" is not a number of milliseconds; using ${DEFAULT_TICK_MS}`
    );
    return DEFAULT_TICK_MS;
  }
  // A floor, because this spends somebody else's rate limit: below a minute a fumbled value would
  // burn a token's hourly allowance in a few hours.
  if (parsed > 0 && parsed < 60_000) {
    console.warn(`GITHUB_SYNC_TICK_MS=${parsed} is below the 60000 floor; using 60000`);
    return 60_000;
  }
  return parsed;
}

/**
 * Carries a known answer forward when this sync could not get one.
 *
 * `withChecks` returns `unknown` for an open pull request it did not ask about — past the cap, or
 * the request failed — and `writeProviderLinks` replaces the whole array, so without this the
 * stored answer is destroyed. On a board with more than `MAX_CHECKED_PULL_REQUESTS` open pull
 * requests the ordering is deterministic, so the same ones are starved on every tick and their
 * badges would read "?" for ever; one transient 502 does the same to a single badge.
 *
 * Only when the head commit is the same one. A different commit makes the old answer an answer
 * about something else, and `unknown` is then the truth.
 */
function carryForward(
  fresh: { number: number; ci: CiState; ciLabel: string | null; headSha: string | null },
  stored: ILinkedPR[] | undefined
): { ci: CiState; ciLabel: string | null } {
  if (fresh.ci !== "unknown") return { ci: fresh.ci, ciLabel: fresh.ciLabel };
  const previous = stored?.find(
    (link) => (link.provider ?? "github") === "github" && link.number === fresh.number
  );
  if (!previous?.ci || !CARRYABLE.has(previous.ci)) return { ci: fresh.ci, ciLabel: fresh.ciLabel };
  if (!fresh.headSha || previous.headSha !== fresh.headSha) {
    return { ci: fresh.ci, ciLabel: fresh.ciLabel };
  }
  return { ci: previous.ci, ciLabel: previous.ciLabel ?? null };
}

/**
 * The states worth keeping when this sync could not ask: the ones that were finished when we last
 * looked.
 *
 * `running` is deliberately not among them. A pull request past the cap is never asked about again,
 * and GitHub does not touch a pull request's `updated_at` when a check run finishes — checks hang
 * off the commit — so a carried `running` would pulse "e2e running" for ever on a branch whose
 * build ended an hour ago. Degrading it to `unknown` says the true thing: we looked once, it was
 * running, and we have not looked since.
 */
const CARRYABLE = new Set<CiState>(["success", "failure", "none"]);

/**
 * Everything a sync can change about one link.
 *
 * Named, and `prDocs` below is typed as an array of it, so the two sides are checked against each
 * other by the compiler. `unchanged` used to take a four-field shape with a cast to silence the
 * mismatch — which meant a tenth field added to `prDocs` and forgotten here would compile, pass
 * every test, and silently freeze that field's badge for ever.
 */
// A type alias rather than an interface: `writeProviderLinks` takes `Record<string, unknown>`, and
// only an alias gets the implicit index signature that satisfies it.
type Signable = {
  number: number;
  title: string;
  state: string;
  url: string;
  mergedAt?: Date | null;
  updatedAt?: Date | null;
  ci?: CiState;
  ciLabel?: string | null;
  headSha?: string | null;
};

/**
 * A date as a comparable value.
 *
 * `getTime()` on an Invalid Date is `NaN`, and `JSON.stringify` writes `NaN` as `null` — which is
 * also how an absent date is written, and how every *other* Invalid Date is written. Two genuinely
 * different malformed dates would compare equal for ever, and a link that acquired one would look
 * unchanged against a link that had none. It takes a malformed timestamp from whatever
 * `GITHUB_API_BASE_URL` names, so it is unlikely; the collapse is silent and permanent, which is
 * what makes it worth two lines.
 */
function stamp(date: Date | null | undefined): number | string | null {
  if (!date) return null;
  const time = date.getTime();
  return Number.isFinite(time) ? time : `invalid:${String(date)}`;
}

/** A link reduced to what a sync can change about it, for comparing one round against the last. */
function signature(link: Signable): string {
  return JSON.stringify([
    link.number,
    link.title,
    link.state,
    link.url,
    stamp(link.mergedAt),
    stamp(link.updatedAt),
    link.ci ?? "none",
    link.ciLabel ?? null,
    link.headSha ?? null,
  ]);
}

/**
 * Whether this sync learned anything about a task's GitHub links.
 *
 * The write is skipped when it did not, and that is not an optimisation. `taskSchema` has
 * `timestamps: true`, and Mongoose appends `$set: { updatedAt: now }` to a pipeline update — so an
 * unconditional write moved every task with a pull request to "just now" every five minutes. The
 * dashboard reads `updatedAt` on a done task as the date it was finished
 * (`api/projects/[id]/stats`), so tasks closed weeks ago would have reported as finished this week
 * for as long as their merged pull request stayed in GitHub's recently-closed window; My Tasks,
 * search and suggestions all sort by it too. `tasks/reorder` carries the same warning about drags.
 */
function unchanged(stored: ILinkedPR[] | undefined, fresh: Signable[]): boolean {
  // The stored side is the **hydrated** document, so Mongoose has already filled `ci: "none"`,
  // `ciLabel: null` and `headSha: null` from the schema's defaults for a link written before
  // BP-443 — this half is therefore partly describing defaults rather than stored bytes. What
  // saves it is `headSha`: GitHub returns `head.sha` for open, closed and merged pull requests
  // alike, so the fresh side always differs from that `null` and an old link is healed on the
  // first sync. The margin is one field wide — drop `headSha` from `prDocs` and every pre-BP-443
  // link becomes permanently "unchanged".
  const before = (stored ?? [])
    .filter((link) => (link.provider ?? "github") === "github")
    .map(signature)
    .sort();
  const after = fresh.map(signature).sort();
  // Sorted on both sides, so this is multiset equality: the same links in a different order are
  // unchanged. `fetchPullRequests` concatenates two differently-ordered pages, so a task with two
  // pull requests genuinely does see them arrive in either order between ticks — and without the
  // sort that reads as a change, writes, and brings back the `updatedAt` corruption this exists to
  // prevent, on exactly the tasks with the most pull-request activity.
  //
  // The flip side, stated because it is what "unchanged" means here rather than an oversight: a
  // permutation of field values *across* two links in one task is invisible to it.
  return before.length === after.length && before.every((line, i) => line === after[i]);
}

export type SyncResult =
  | {
      ok: true;
      prsFound: number;
      tasksLinked: number;
      prsLinked: number;
      /** Tasks whose links this sync actually rewrote — see `unchanged`. */
      tasksWritten: number;
      autoTransitioned: number;
    }
  | { ok: false; status: number; error: string };

/**
 * One project's GitHub sync: the pull requests, what CI says about them, and the transition a
 * merge earns.
 *
 * Lifted out of the route so the scheduler below can run the same code rather than a second copy
 * of it — the route keeps only the turning of a result into a response.
 *
 * `actor` is who asked. A background tick has nobody to name, and that is exactly why it does not
 * move tasks between columns: an unattended transition with an invented author is a row in a
 * task's history that no person can be asked about. So a tick refreshes what the badges show and
 * leaves the pipeline alone; a person clicking Sync gets both, as before.
 */
export async function syncGithubPullRequests(
  project: SyncableProject,
  actor: string | null,
  /**
   * When set, only this task number may be moved out of review. The task detail's Refresh is
   * about one task, and one GitHub request answers for every branch anyway — so it refreshes
   * every link and transitions only the task the person is looking at. Without this a button
   * labelled "Refresh PR status" moved other people's tasks, under the clicking user's name.
   */
  transitionOnly?: number
): Promise<SyncResult> {
  const repositoryUrl = projectRepositoryUrl(project);
  if (!repositoryUrl || !project.githubToken) {
    return {
      ok: false,
      status: 400,
      error: "A repository URL and a GitHub token must be configured in project settings",
    };
  }
  if (repositoryProvider(project) !== "github") {
    return {
      ok: false,
      status: 400,
      error: `${repositoryUrl} is not a GitHub repository, so there are no pull requests to sync`,
    };
  }
  const parsed = parseRepoString(repositoryUrl);
  if (!parsed) {
    return {
      ok: false,
      status: 400,
      error: `Could not read an owner and repository out of ${repositoryUrl}`,
    };
  }

  const token = decryptSecret(project.githubToken);
  const rawPRs = await fetchPullRequests(parsed.owner, parsed.repo, token);
  const matchedPRs = await withChecks(
    matchPRsToTasks(rawPRs, project.key, project.formerKeys || []),
    parsed.owner,
    parsed.repo,
    token,
    // A person looking at one task gets a real look at it, cap or no cap
    transitionOnly
  );

  const prsByTask = new Map<number, typeof matchedPRs>();
  for (const pr of matchedPRs) {
    const existing = prsByTask.get(pr.matchedTaskNumber) || [];
    existing.push(pr);
    prsByTask.set(pr.matchedTaskNumber, existing);
  }

  let linked = 0;
  let written = 0;
  let autoTransitioned = 0;
  const columnIds = new Set(getProjectColumns(project).map((c) => c.id));

  for (const [taskNumber, prs] of prsByTask) {
    const task = await Task.findOne({ project: project._id, taskNumber });
    if (!task) continue;

    const prDocs: (Signable & { provider: "github" })[] = prs.map((pr) => ({
      provider: "github" as const,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      url: pr.url,
      mergedAt: pr.mergedAt,
      updatedAt: pr.updatedAt,
      ...carryForward(pr, task.linkedPRs),
      headSha: pr.headSha,
    }));

    // Replaced in the database rather than in JS, because two syncs of the same task overlap
    // easily — a scheduled one against a double-clicked manual one — and read-mutate-save means
    // the second write silently drops whatever the first one added (BP-559). `$filter` keeps the
    // other provider's links.
    //
    // Dates are built here, not left to the schema: a pipeline update is not cast by Mongoose.
    if (!unchanged(task.linkedPRs, prDocs)) {
      await writeProviderLinks(task._id, "github", prDocs);
      written++;
    }
    linked += prs.length;

    // Auto-transition: merged PR + task in_review → ready_to_test.
    // Keyed to the seeded column ids; projects that removed either column opt out.
    const hasMerged = prs.some((pr) => pr.state === "merged");
    const mayTransition = transitionOnly === undefined || transitionOnly === taskNumber;
    if (
      actor &&
      mayTransition &&
      hasMerged &&
      task.status === "in_review" &&
      columnIds.has("ready_to_test")
    ) {
      // Guarded on the status just read, the way BP-489 guards every other status write: without
      // it two overlapping syncs both saw `in_review`, both wrote `ready_to_test`, and both logged
      // the transition — one move, two rows in the task's history.
      const moved = await Task.updateOne(
        { _id: task._id, status: "in_review" },
        { $set: { status: "ready_to_test" } }
      );
      if (moved.modifiedCount === 1) {
        autoTransitioned++;
        await logActivity(
          String(task._id),
          actor,
          "status_changed",
          "status",
          "in_review",
          "ready_to_test"
        );
      }
    }
  }

  return {
    ok: true,
    prsFound: matchedPRs.length,
    tasksLinked: prsByTask.size,
    prsLinked: linked,
    tasksWritten: written,
    autoTransitioned,
  };
}

/**
 * Refreshes every project that has a GitHub repository and a token.
 *
 * The rate-limit arithmetic. One tick costs two requests for the pull-request listing, plus **two
 * to four** per open pull request up to `MAX_CHECKED_PULL_REQUESTS` — one commit-status call and up
 * to `MAX_CHECK_RUN_PAGES` pages of check runs. So at most 2 + 20 × 4 = **82** per project, about
 * 1,000 an hour at the default interval; the ordinary case, one page of check runs, is 42 and about
 * 500. The first version of this comment said 42 was the worst case, which was true until check
 * runs were paged and then quietly was not.
 *
 * What that is a tenth of is worth stating precisely, because the first version of this comment got
 * it wrong: GitHub's 5,000 an hour is **per account**, not per token and not per project. Ten
 * boards configured with the same person's token share one budget, and nothing in the product warns
 * that a token has been pasted twice. So the honest claim is 500 an hour per project, and an
 * operator running many boards off one account should raise `GITHUB_SYNC_TICK_MS` or give each
 * board a token of its own.
 *
 * Two further things the number assumes and nothing enforces: one replica, and no overlapping
 * ticks. The second is guarded below; the first is not, so N replicas cost N times this.
 */
export async function githubSyncTick(): Promise<void> {
  await connectDB();
  const projects = await Project.find(
    { githubToken: { $nin: [null, ""] } },
    // `gitlabHost` because `repositoryProvider` reads it for a self-hosted GitLab; a projection
    // that omits a field the shared helper consults is a bug waiting for that helper to change
    "key formerKeys githubRepo repositoryUrl gitlabRepo gitlabHost githubToken columns"
  ).lean();

  for (const project of projects) {
    try {
      const result = await syncGithubPullRequests(project, null);
      if (!result.ok) continue;
    } catch (err) {
      // One unreachable repository must not stop the others
      console.error(`GitHub sync failed for ${project.key}:`, err);
    }
  }
}

let started = false;
// A tick loops every configured project and can outlive its own interval on a slow GitHub. Without
// this, ticks stack: the spend doubles and keeps doubling, against somebody else's rate limit.
let ticking = false;

/** What `startGithubSyncScheduler` did, so the caller can say which without guessing from a number. */
export type SchedulerStart =
  | { started: true; tickMs: number }
  | { started: false; reason: "off" | "already running" };

export function startGithubSyncScheduler(): SchedulerStart {
  const tick = syncTickMs();
  // Two different noes, told apart: a second `register()` — which `next dev` does on reload — used
  // to return the same 0 as "switched off", so the log said the sync was off while it was running.
  if (started) return { started: false, reason: "already running" };
  if (tick === 0) return { started: false, reason: "off" };
  started = true;
  setInterval(() => {
    if (ticking) {
      console.warn("GitHub sync tick skipped: the previous one is still running");
      return;
    }
    ticking = true;
    githubSyncTick()
      .catch((err) => console.error("GitHub sync tick failed:", err))
      .finally(() => {
        ticking = false;
      });
  }, tick).unref();
  return { started: true, tickMs: tick };
}
