import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";

export const DELETE = withProjectAccess(async (_request, { params }) => {
  const { projectId, fieldId } = await params;
  await connectDB();

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  project.customFields = (project.customFields || []).filter(
    (f) => f._id.toString() !== fieldId
  );
  await project.save();

  // Clean up orphaned values from all tasks in this project
  await Task.updateMany(
    { project: projectId },
    { $unset: { [`customFieldValues.${fieldId}`]: "" } }
  );

  return NextResponse.json(project.customFields);
});
