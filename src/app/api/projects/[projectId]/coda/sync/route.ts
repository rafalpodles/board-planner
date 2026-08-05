import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { Task } from "@/models/task";
import { User } from "@/models/user";
import { decryptSecret } from "@/lib/encryption";
import { getProjectColumns } from "@/lib/columns";
import {
  CodaTaskRow,
  fetchTableColumns,
  missingColumns,
  normaliseCodaHost,
  upsertTaskRows,
} from "@/lib/coda";

export const POST = withProjectOwner(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const project = await Project.findById(projectId).lean();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (!project.codaDocId || !project.codaTableId || !project.codaToken) {
    return NextResponse.json(
      { error: "Coda doc, table and token must be configured in project settings" },
      { status: 400 }
    );
  }

  const host = normaliseCodaHost(project.codaHost);
  const token = decryptSecret(project.codaToken);

  let columns: string[];
  try {
    columns = await fetchTableColumns(host, project.codaDocId, project.codaTableId, token);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Coda request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const missing = missingColumns(columns);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Coda table is missing columns: ${missing.join(", ")}` },
      { status: 400 }
    );
  }

  const tasks = await Task.find(
    { project: projectId },
    "taskNumber title status assignee priority category dueDate customFieldValues"
  )
    .sort({ taskNumber: 1 })
    .populate<{ assignee: { fullName?: string; username: string } | null }>(
      "assignee",
      "fullName username"
    )
    .lean();

  const columnLabels = new Map(getProjectColumns(project).map((c) => [c.id, c.label]));
  // Difficulty is a project field since CP-213; the Coda table still has a column
  // for it, so it is read from the field rather than left blank
  const difficultyField = (project.customFields || []).find(
    (f: { name: string }) => f.name.toLowerCase() === "difficulty"
  );
  // Mongoose hands customFieldValues back as a Map; a lean or raw read gives a
  // plain object, and both shapes reach this route depending on the caller
  const fieldValue = (values: unknown, id: string): string => {
    if (values instanceof Map) return String(values.get(id) ?? "");
    const record = values as Record<string, unknown> | undefined;
    return String(record?.[id] ?? "");
  };
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");

  const rows: CodaTaskRow[] = tasks.map((task) => ({
    key: `${project.key}-${task.taskNumber}`,
    title: task.title,
    status: columnLabels.get(task.status) || task.status,
    assignee: task.assignee ? task.assignee.fullName || task.assignee.username : "",
    priority: task.priority || "",
    difficulty: difficultyField
      ? fieldValue(task.customFieldValues, String(difficultyField._id))
      : "",
    category: task.category || "",
    due: task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : "",
    link: appUrl ? `${appUrl}/projects/${project.key}/tasks/${task.taskNumber}` : "",
  }));

  try {
    const result = await upsertTaskRows(
      host,
      project.codaDocId,
      project.codaTableId,
      token,
      rows
    );
    return NextResponse.json({
      synced: true,
      tasksPushed: result.pushed,
      requests: result.requests,
      // Coda queues writes; a false here means they were accepted but not yet applied
      allApplied: result.allApplied,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Coda request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
});
