import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { fetchMergeRequests, matchMRsToTasks, parseGitlabRepo } from "@/lib/gitlab";
import { logActivity } from "@/lib/activity";
import { decryptSecret } from "@/lib/encryption";
import { mergedReviewDestination } from "@/lib/columns";
import { projectRepositoryUrl, repositoryProvider } from "@/lib/repository";
import {
  addedLinks,
  recordLinkChanges,
  removedLinks,
  seenUrls,
  writeProviderLinks,
} from "@/lib/pr-links";

export const POST = withProjectAccess(async (_request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId).lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const repositoryUrl = projectRepositoryUrl(project);
  if (!repositoryUrl || !project.gitlabToken) {
    return NextResponse.json(
      { error: "A repository URL and a GitLab token must be configured in project settings" },
      { status: 400 }
    );
  }

  // A self-hosted GitLab has no telling hostname, so this is where the project's own gitlabHost
  // does the classifying — see src/lib/repository.ts
  if (repositoryProvider(project) !== "gitlab") {
    return NextResponse.json(
      { error: `${repositoryUrl} is not a GitLab repository. A self-hosted one also needs its GitLab host set.` },
      { status: 400 }
    );
  }

  const projectPath = parseGitlabRepo(repositoryUrl);
  if (!projectPath) {
    return NextResponse.json(
      { error: `Could not read a group and project out of ${repositoryUrl}` },
      { status: 400 }
    );
  }

  const host = project.gitlabHost || "https://gitlab.com";
  let rawMRs;
  try {
    rawMRs = await fetchMergeRequests(host, projectPath, decryptSecret(project.gitlabToken));
  } catch (err) {
    const message = err instanceof Error ? err.message : "GitLab request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
  const matchedMRs = matchMRsToTasks(rawMRs, project.key, project.formerKeys || []);

  const mrsByTask = new Map<number, typeof matchedMRs>();
  for (const mr of matchedMRs) {
    const existing = mrsByTask.get(mr.matchedTaskNumber) || [];
    existing.push(mr);
    mrsByTask.set(mr.matchedTaskNumber, existing);
  }

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

  let linked = 0;
  let unlinked = 0;
  let autoTransitioned = 0;

  for (const [taskNumber, mrs] of mrsByTask) {
    const task = await Task.findOne({ project: projectId, taskNumber });
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
    await writeProviderLinks(task._id, "gitlab", mrDocs, seenList);
    // The trace a link change leaves on the task, since nothing else does any more (BP-628)
    await recordLinkChanges(task._id, String(user._id), added, removed);
    unlinked += removed.length;
    linked += mrs.length;

    const hasMerged = mrs.some((mr) => mr.state === "merged");
    const destination = hasMerged ? mergedReviewDestination(project, task.status) : undefined;
    if (destination) {
      // Guarded on the status just read (BP-489's rule): two overlapping syncs both saw the same
      // review column and both logged the move, so one transition wrote two history rows.
      const oldStatus = task.status;
      const moved = await Task.updateOne(
        { _id: task._id, status: oldStatus },
        { $set: { status: destination } }
      );
      if (moved.modifiedCount === 1) {
        autoTransitioned++;
        await logActivity(String(task._id), user._id, "status_changed", "status", oldStatus, destination);
      }
    }
  }

  // The tasks this round contradicts without visiting: a merge request retitled onto another task
  // leaves its old task's grouping, so that task is never in the loop above and its stale link
  // survived every later sync (BP-610). `provider: null` is not in the query here — an unmarked
  // link is GitHub's, and a GitLab sync must not adopt it.
  if (seenList.length > 0) {
    const contradicted = await Task.find({
      project: projectId,
      linkedPRs: { $elemMatch: { url: { $in: seenList }, provider: "gitlab" } },
    });
    for (const task of contradicted) {
      if (mrsByTask.has(task.taskNumber)) continue;
      const removed = removedLinks(task.linkedPRs, "gitlab", seen, new Set());
      if (removed.length === 0) continue;
      await writeProviderLinks(task._id, "gitlab", [], seenList);
      await recordLinkChanges(task._id, String(user._id), [], removed);
      unlinked += removed.length;
    }
  }

  return NextResponse.json({
    synced: true,
    prsFound: matchedMRs.length,
    tasksLinked: mrsByTask.size,
    prsLinked: linked,
    prsUnlinked: unlinked,
    autoTransitioned,
  });
});
