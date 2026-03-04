import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { fetchPullRequests, matchPRsToTasks, parseRepoString } from "@/lib/github";
import { logActivity } from "@/lib/activity";

export const POST = withProjectAccess(async (_request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId).lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.githubRepo || !project.githubToken) {
    return NextResponse.json(
      { error: "GitHub repo and token must be configured in project settings" },
      { status: 400 }
    );
  }

  const parsed = parseRepoString(project.githubRepo);
  if (!parsed) {
    return NextResponse.json(
      { error: "Invalid GitHub repo format. Use 'owner/repo'." },
      { status: 400 }
    );
  }

  // Fetch PRs from GitHub
  const rawPRs = await fetchPullRequests(parsed.owner, parsed.repo, project.githubToken);
  const matchedPRs = matchPRsToTasks(rawPRs, project.key);

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
      number: pr.number,
      title: pr.title,
      state: pr.state,
      url: pr.url,
      mergedAt: pr.mergedAt,
      updatedAt: pr.updatedAt,
    }));

    task.linkedPRs = prDocs as typeof task.linkedPRs;
    linked += prs.length;

    // Auto-transition: merged PR + task in_review → ready_to_test
    const hasMerged = prs.some((pr) => pr.state === "merged");
    if (hasMerged && task.status === "in_review") {
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
