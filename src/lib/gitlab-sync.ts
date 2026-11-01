import { fetchMergeRequests, matchMRsToTasks, parseGitlabRepo } from "@/lib/gitlab";
import { logActivity } from "@/lib/activity";
import { decryptSecret } from "@/lib/encryption";
import { mergedReviewDestination } from "@/lib/columns";
import { NOT_ARCHIVED } from "@/lib/task-archive";
import { projectRepositoryUrl, repositoryProvider, storedRepositories } from "@/lib/repository";
import { repositoriesOfProvider } from "@/lib/repo-match";
import type { RepositoryFields } from "@/lib/repository";
import type { ScopedDb } from "@/lib/db-scope";
import {
  addedLinks,
  recordLinkChanges,
  removedLinks,
  requestsByTask,
  seenUrls,
  writeProviderLinks,
} from "@/lib/pr-links";

/** What a GitLab sync needs of a project: the route reads the whole document, so this is only a floor */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GitlabSyncProject = RepositoryFields & { _id: any; key: string; formerKeys?: string[] | null; gitlabToken?: string | null } & Record<string, any>;

type GitlabRound = GitlabSyncResult & { taskNumbers?: number[] };

export type GitlabSyncResult =
  | {
      ok: true;
      prsFound: number;
      tasksLinked: number;
      prsLinked: number;
      prsUnlinked: number;
      autoTransitioned: number;
      /** Repositories of a project that lists several which could not be read; the others were synced. */
      failed?: { repository: string; error: string }[];
    }
  | { ok: false; status: number; error: string };

/**
 * A project's GitLab sync: every GitLab repository it lists, one round each. What a round saw is
 * named by url, so one repository's round never touches the links another's merge requests gave a task.
 * One that cannot be read does not stop the others, and is named in the answer.
 */
export async function syncGitlabMergeRequests(db: ScopedDb, project: GitlabSyncProject, actor: string): Promise<GitlabSyncResult> {
  if (storedRepositories(project).length <= 1) {
    return withoutTasks(await syncGitlabRepository(db, project, projectRepositoryUrl(project), actor));
  }
  const urls = repositoriesOfProvider(project, "gitlab");
  if (urls.length === 0) return withoutTasks(await syncGitlabRepository(db, project, projectRepositoryUrl(project), actor));

  const total = { prsFound: 0, prsLinked: 0, prsUnlinked: 0, autoTransitioned: 0 };
  const tasks = new Set<number>();
  const failed: { repository: string; error: string }[] = [];
  let first: GitlabSyncResult | undefined;
  let any = false;
  for (const url of urls) {
    let result: GitlabRound;
    try {
      result = await syncGitlabRepository(db, project, url, actor);
    } catch (err) {
      // A write that failed in this round; the rounds before it have landed and are kept
      result = { ok: false, status: 500, error: (err instanceof Error ? err.message : "the sync failed").split("\n")[0].slice(0, 200) };
    }
    if (!result.ok) {
      failed.push({ repository: url, error: result.error });
      first ??= result;
      continue;
    }
    any = true;
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += result[key];
    for (const number of result.taskNumbers ?? []) tasks.add(number);
  }
  if (!any && first) return first;
  return { ok: true, ...total, tasksLinked: tasks.size, ...(failed.length > 0 ? { failed } : {}) };
}

function withoutTasks(result: GitlabRound): GitlabSyncResult {
  if (!result.ok) return result;
  const { taskNumbers: _taskNumbers, ...answer } = result;
  return answer;
}

async function syncGitlabRepository(db: ScopedDb, project: GitlabSyncProject, repositoryUrl: string, actor: string): Promise<GitlabRound> {
  if (!repositoryUrl || !project.gitlabToken) {
    return { ok: false, status: 400, error: "A repository URL and a GitLab token must be configured in project settings" };
  }

  // A self-hosted GitLab has no telling hostname, so this is where the project's own gitlabHost
  // does the classifying — see src/lib/repository.ts
  if (repositoryProvider({ ...project, repositoryUrl }) !== "gitlab") {
    return {
      ok: false,
      status: 400,
      error: `${repositoryUrl} is not a GitLab repository. A self-hosted one also needs its GitLab host set.`,
    };
  }

  const projectPath = parseGitlabRepo(repositoryUrl);
  if (!projectPath) {
    return { ok: false, status: 400, error: `Could not read a group and project out of ${repositoryUrl}` };
  }

  const host = project.gitlabHost || "https://gitlab.com";
  let rawMRs;
  try {
    rawMRs = await fetchMergeRequests(host, projectPath, decryptSecret(project.gitlabToken, db.organisation));
  } catch (err) {
    const message = err instanceof Error ? err.message : "GitLab request failed";
    return { ok: false, status: 502, error: message };
  }
  const matchedMRs = matchMRsToTasks(rawMRs, project.key, project.formerKeys || []);

  const mrsByTask = requestsByTask(matchedMRs);

  // Every merge request this round saw, matched or not. The fetch is a window — a hundred by
  // `updated_at`, no paging — so a link the round did not see is unknown rather than gone, while
  // one it saw and gave to somebody else is a fact (BP-610, BP-617). Named by url, so a repointed
  // project's numbers do not contradict the old repository's links (BP-631).
  const seenList = seenUrls(
    "gitlab",
    repositoryUrl,
    rawMRs.map((mr) => ({ number: mr.iid, url: mr.web_url }))
  );
  const seen = new Set(seenList);

  const linked = new Set<string>();
  const tasksLinked = new Set<number>();
  let unlinked = 0;
  let autoTransitioned = 0;

  for (const [taskNumber, mrs] of mrsByTask) {
    const task = await db.Task.findOne({ project: project._id, taskNumber });
    if (!task) continue;

    const mrDocs = mrs.map((mr) => ({
      provider: "gitlab" as const,
      number: mr.number,
      title: mr.title,
      state: mr.state,
      url: mr.url,
      mergedAt: mr.mergedAt,
      updatedAt: mr.updatedAt,
    }));

    // In the database rather than in JS, for the reason its GitHub twin carries: two overlapping
    // syncs of one task meant the later save dropped whatever the earlier one had added (BP-559).
    // Dates are built above, because a pipeline update is not cast by Mongoose.
    const added = addedLinks(task.linkedPRs, "gitlab", mrDocs);
    const removed = removedLinks(
      task.linkedPRs,
      "gitlab",
      seen,
      new Set(mrDocs.map((doc) => doc.url))
    );
    await writeProviderLinks(db, task._id, "gitlab", mrDocs, seenList);
    // The trace a link change leaves on the task, since nothing else does any more (BP-628)
    await recordLinkChanges(db, project._id, task._id, actor, added, removed);
    unlinked += removed.length;
    for (const mr of mrs) linked.add(mr.url);
    tasksLinked.add(taskNumber);

    const hasMerged = mrs.some((mr) => mr.state === "merged");
    const destination = hasMerged ? mergedReviewDestination(project as never, task.status) : undefined;
    if (destination) {
      // Guarded on the status just read (BP-489's rule): two overlapping syncs both saw the same
      // review column and both logged the move, so one transition wrote two history rows.
      const oldStatus = task.status;
      const moved = await db.Task.updateOne(
        { _id: task._id, status: oldStatus, "execution.runId": { $in: ["", null] }, ...NOT_ARCHIVED },
        { $set: { status: destination } }
      );
      if (moved.modifiedCount === 1) {
        autoTransitioned++;
        await logActivity(db, project._id, String(task._id), actor, "status_changed", "status", oldStatus, destination);
      }
    }
  }

  // The tasks this round contradicts without visiting: a merge request retitled onto another task
  // leaves its old task's grouping, so that task is never in the loop above and its stale link
  // survived every later sync (BP-610). `provider: null` is not in the query here — an unmarked
  // link is GitHub's, and a GitLab sync must not adopt it.
  if (seenList.length > 0) {
    const contradicted = await db.Task.find({
      project: project._id,
      linkedPRs: { $elemMatch: { url: { $in: seenList }, provider: "gitlab" } },
    });
    for (const task of contradicted) {
      if (mrsByTask.has(task.taskNumber)) continue;
      const removed = removedLinks(task.linkedPRs, "gitlab", seen, new Set());
      if (removed.length === 0) continue;
      await writeProviderLinks(db, task._id, "gitlab", [], seenList);
      await recordLinkChanges(db, project._id, task._id, actor, [], removed);
      unlinked += removed.length;
    }
  }

  return {
    ok: true,
    prsFound: matchedMRs.length,
    tasksLinked: tasksLinked.size,
    taskNumbers: [...tasksLinked],
    prsLinked: linked.size,
    prsUnlinked: unlinked,
    autoTransitioned,
  };
}
