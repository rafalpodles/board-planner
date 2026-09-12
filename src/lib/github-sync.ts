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
import type { IProjectColumn } from "@/types";

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

const TICK_MS = Number(process.env.GITHUB_SYNC_TICK_MS ?? 5 * 60 * 1000);

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
  actor: string | null
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
      ci: pr.ci,
      ciLabel: pr.ciLabel,
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
    if (actor && hasMerged && task.status === "in_review" && columnIds.has("ready_to_test")) {
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
    "key formerKeys githubRepo repositoryUrl gitlabRepo githubToken columns"
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

export function startGithubSyncScheduler(): void {
  // Zero turns it off, which is the switch an operator has if a token is rate-limited elsewhere
  if (started || !(TICK_MS > 0)) return;
  started = true;
  setInterval(() => {
    githubSyncTick().catch((err) => console.error("GitHub sync tick failed:", err));
  }, TICK_MS).unref();
}
