import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess, withAdmin } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { Comment } from "@/models/comment";
import { ActivityLog } from "@/models/activityLog";
import { ProjectAuditLog } from "@/models/projectAuditLog";
import { Sprint } from "@/models/sprint";
import { Notification } from "@/models/notification";
import { logProjectAudit } from "@/lib/projectAudit";

export const GET = withProjectAccess(async (_request, { params }) => {
  await connectDB();
  const { projectId } = await params;

  const project = await Project.findById(projectId).populate(
    "owner",
    "username fullName"
  );

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Strip token, expose only boolean flag
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = project.toObject();
  obj.githubTokenSet = !!obj.githubToken;
  delete obj.githubToken;
  return NextResponse.json(obj);
});

export const PUT = withAdmin(async (request, { params, user }) => {
  await connectDB();
  const { projectId } = await params;
  const body = await request.json();

  const allowed = ["name", "description", "key", "githubRepo", "githubToken"];
  const updates: Record<string, unknown> = {};
  for (const field of allowed) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  const project = await Project.findByIdAndUpdate(projectId, updates, {
    new: true,
  }).populate("owner", "username fullName");

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const changedFields = Object.keys(updates)
    .filter((f) => f !== "githubToken")
    .join(", ");
  const auditDetail = updates.githubToken !== undefined
    ? `Changed: ${changedFields ? changedFields + ", " : ""}GitHub token`
    : `Changed: ${changedFields}`;
  logProjectAudit(projectId, user._id, "settings_updated", auditDetail);

  // Strip token from response
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = project.toObject();
  obj.githubTokenSet = !!obj.githubToken;
  delete obj.githubToken;
  return NextResponse.json(obj);
});

export const DELETE = withAdmin(async (_request, { params }) => {
  await connectDB();
  const { projectId } = await params;

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Delete all comments and activity logs on tasks in this project
  const taskIds = await Task.find({ project: projectId }).distinct("_id");
  await Promise.all([
    Comment.deleteMany({ task: { $in: taskIds } }),
    ActivityLog.deleteMany({ task: { $in: taskIds } }),
  ]);

  // Delete all tasks, sprints, notifications in this project
  await Task.deleteMany({ project: projectId });
  await Sprint.deleteMany({ project: projectId });
  await Notification.deleteMany({ project: projectId });

  // Delete project audit logs and the project itself
  await ProjectAuditLog.deleteMany({ project: projectId });
  await Project.findByIdAndDelete(projectId);

  return NextResponse.json({ message: "Project deleted" });
});
