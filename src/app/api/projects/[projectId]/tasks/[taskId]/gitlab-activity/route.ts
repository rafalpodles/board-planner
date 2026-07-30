import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { fetchTaskBranches, fetchTaskCommits, parseGitlabRepo } from "@/lib/gitlab";
import { decryptSecret } from "@/lib/encryption";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId, taskId } = await params;
  await connectDB();

  const project = await Project.findById(projectId, "key gitlabRepo gitlabHost gitlabToken").lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const task = await Task.findOne({ _id: taskId, project: projectId }, "taskNumber").lean();
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const projectPath = project.gitlabRepo ? parseGitlabRepo(project.gitlabRepo) : null;
  if (!projectPath || !project.gitlabToken) {
    return NextResponse.json({ configured: false, branches: [], commits: [] });
  }

  const host = project.gitlabHost || "https://gitlab.com";
  const token = decryptSecret(project.gitlabToken);
  const taskKey = `${project.key}-${task.taskNumber}`;

  // Commit search needs GitLab's search feature; a repo without it should still
  // show branches rather than failing the whole panel
  const [branches, commits] = await Promise.allSettled([
    fetchTaskBranches(host, projectPath, token, taskKey),
    fetchTaskCommits(host, projectPath, token, taskKey),
  ]);

  if (branches.status === "rejected" && commits.status === "rejected") {
    return NextResponse.json(
      { error: branches.reason instanceof Error ? branches.reason.message : "GitLab request failed" },
      { status: 502 }
    );
  }

  return NextResponse.json({
    configured: true,
    branches: branches.status === "fulfilled" ? branches.value : [],
    commits: commits.status === "fulfilled" ? commits.value : [],
    partialError:
      branches.status === "rejected"
        ? "Could not load branches"
        : commits.status === "rejected"
          ? "Could not load commits"
          : null,
  });
});
