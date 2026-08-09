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

    // Replace only this provider's entries; GitLab links stay untouched
    const others = (task.linkedPRs || []).filter((pr) => (pr.provider ?? "github") !== "github");
    task.linkedPRs = [...others, ...prDocs] as typeof task.linkedPRs;
    linked += prs.length;

    // Auto-transition: merged PR + task in_review → ready_to_test.
    // Keyed to the seeded column ids; projects that removed either column opt out.
    const hasMerged = prs.some((pr) => pr.state === "merged");
    const columnIds = new Set(getProjectColumns(project).map((c) => c.id));
    if (hasMerged && task.status === "in_review" && columnIds.has("ready_to_test")) {
      const oldStatus = task.status;
      task.status = "ready_to_test";
      autoTransitioned++;
      await logActivity(
        String(task._id),
        user._id,
        "status_changed",
        "status",
        oldStatus,
        "ready_to_test"
      );
    }

    await task.save();
  }

  return NextResponse.json({
    synced: true,
    prsFound: matchedPRs.length,
    tasksLinked: prsByTask.size,
    prsLinked: linked,
    autoTransitioned,
  });
});
