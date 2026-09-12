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
  if (!previous?.ci || previous.ci === "unknown") return { ci: fresh.ci, ciLabel: fresh.ciLabel };
  if (!fresh.headSha || previous.headSha !== fresh.headSha) {
    return { ci: fresh.ci, ciLabel: fresh.ciLabel };
  }
  return { ci: previous.ci, ciLabel: previous.ciLabel ?? null };
}

export type SyncResult =
  | {
      ok: true;
      prsFound: number;
      tasksLinked: number;
      prsLinked: number;
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
    token
  );

  const prsByTask = new Map<number, typeof matchedPRs>();
  for (const pr of matchedPRs) {
    const existing = prsByTask.get(pr.matchedTaskNumber) || [];
    existing.push(pr);
    prsByTask.set(pr.matchedTaskNumber, existing);
  }

  let linked = 0;
  let autoTransitioned = 0;
  const columnIds = new Set(getProjectColumns(project).map((c) => c.id));

  for (const [taskNumber, prs] of prsByTask) {
    const task = await Task.findOne({ project: project._id, taskNumber });
    if (!task) continue;

    const prDocs = prs.map((pr) => ({
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
    await writeProviderLinks(task._id, "github", prDocs);
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
    autoTransitioned,
  };
}

/**
 * Refreshes every project that has a GitHub repository and a token.
 *
 * The rate-limit arithmetic, since it is the reason this is safe to leave on: a token is a
 * project's own, so the 5,000 requests an hour are not shared between boards. One tick costs two
 * requests for the pull requests plus two per open pull request up to `MAX_CHECKED_PULL_REQUESTS`,
 * so at most 42 — about 500 an hour at this interval, a tenth of one project's allowance.
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

export function startGithubSyncScheduler(): number {
  const tick = syncTickMs();
  if (started || tick === 0) return 0;
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
  return tick;
}
