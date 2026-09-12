import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { fetchPullRequests, matchPRsToTasks, parseRepoString } from "@/lib/github";
import { logActivity } from "@/lib/activity";
import { decryptSecret } from "@/lib/encryption";
import { getProjectColumns } from "@/lib/columns";
import { projectRepositoryUrl, repositoryProvider } from "@/lib/repository";
import { pruneContradictedLinks, writeProviderLinks } from "@/lib/pr-links";

export const POST = withProjectAccess(async (_request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId).lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const repositoryUrl = projectRepositoryUrl(project);
  if (!repositoryUrl || !project.githubToken) {
    return NextResponse.json(
      { error: "A repository URL and a GitHub token must be configured in project settings" },
      { status: 400 }
    );
  }

  if (repositoryProvider(project) !== "github") {
    return NextResponse.json(
      { error: `${repositoryUrl} is not a GitHub repository, so there are no pull requests to sync` },
      { status: 400 }
    );
  }

  const parsed = parseRepoString(repositoryUrl);
  if (!parsed) {
    return NextResponse.json(
      { error: `Could not read an owner and repository out of ${repositoryUrl}` },
      { status: 400 }
    );
  }

  // Fetch PRs from GitHub (token is encrypted at rest)
  const rawPRs = await fetchPullRequests(parsed.owner, parsed.repo, decryptSecret(project.githubToken));
  const matchedPRs = matchPRsToTasks(rawPRs, project.key, project.formerKeys || []);

  // Group by task number
  const prsByTask = new Map<number, typeof matchedPRs>();
  for (const pr of matchedPRs) {
    const existing = prsByTask.get(pr.matchedTaskNumber) || [];
    existing.push(pr);
    prsByTask.set(pr.matchedTaskNumber, existing);
  }

  let linked = 0;
  let autoTransitioned = 0;

  // Update tasks
  for (const [taskNumber, prs] of prsByTask) {
    const task = await Task.findOne({ project: projectId, taskNumber });
    if (!task) continue;

    // Update linkedPRs array
    const prDocs = prs.map((pr) => ({
      provider: "github" as const,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      url: pr.url,
      mergedAt: pr.mergedAt,
      updatedAt: pr.updatedAt,
    }));

    // Replaced in the database rather than in JS, because two syncs of the same task overlap
    // easily — a scheduled one against a double-clicked manual one — and read-mutate-save means
    // the second write silently drops whatever the first one added (BP-559). `$filter` keeps the
    // other provider's links, which is what the old `others` line did.
    //
    // Dates are built here, not left to the schema: a pipeline update is not cast by Mongoose.
    await writeProviderLinks(task._id, "github", prDocs);
    linked += prs.length;

    // Auto-transition: merged PR + task in_review → ready_to_test.
    // Keyed to the seeded column ids; projects that removed either column opt out.
    const hasMerged = prs.some((pr) => pr.state === "merged");
    const columnIds = new Set(getProjectColumns(project).map((c) => c.id));
    if (hasMerged && task.status === "in_review" && columnIds.has("ready_to_test")) {
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
          user._id,
          "status_changed",
          "status",
          "in_review",
          "ready_to_test"
        );
      }
    }
  }

  // The loop above only ever visits the tasks this round matched, so a pull request that stops
  // matching a task leaves that task out of the grouping and its link behind (BP-610). The numbers
  // this round actually saw are the evidence for removing one — see `contradictedLinkNumbers` for
  // why absence from them is not.
  const prsUnlinked = await pruneContradictedLinks({
    projectId,
    provider: "github",
    linkedThisRound: new Set(prsByTask.keys()),
    seenNumbers: new Set(rawPRs.map((raw) => raw.number)),
  });

  return NextResponse.json({
    synced: true,
    prsFound: matchedPRs.length,
    tasksLinked: prsByTask.size,
    prsLinked: linked,
    prsUnlinked,
    autoTransitioned,
  });
});
