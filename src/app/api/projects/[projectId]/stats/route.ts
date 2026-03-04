import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { TASK_STATUSES } from "@/types";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const tasks = await Task.find({ project: projectId })
    .populate("assignee", "username fullName")
    .lean();

  // Status breakdown
  const statusBreakdown: Record<string, number> = {};
  for (const s of TASK_STATUSES) {
    statusBreakdown[s] = 0;
  }
  for (const t of tasks) {
    statusBreakdown[t.status] = (statusBreakdown[t.status] || 0) + 1;
  }

  // Category breakdown
  const categoryBreakdown: Record<string, number> = {};
  for (const t of tasks) {
    categoryBreakdown[t.category] = (categoryBreakdown[t.category] || 0) + 1;
  }

  // Assignee breakdown
  const assigneeBreakdown: Record<string, number> = {};
  for (const t of tasks) {
    const assignee = t.assignee && typeof t.assignee === "object" && "fullName" in t.assignee
      ? (t.assignee as { fullName: string }).fullName
      : "Unassigned";
    assigneeBreakdown[assignee] = (assigneeBreakdown[assignee] || 0) + 1;
  }

  // Velocity: tasks completed per week (last 8 weeks)
  const now = new Date();
  const velocity: { week: string; count: number }[] = [];
  for (let i = 7; i >= 0; i--) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - (i + 1) * 7);
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - i * 7);

    const count = tasks.filter((t) => {
      if (t.status !== "done") return false;
      const updated = new Date(t.updatedAt);
      return updated >= weekStart && updated < weekEnd;
    }).length;

    const label = `${weekStart.getMonth() + 1}/${weekStart.getDate()}`;
    velocity.push({ week: label, count });
  }

  // Tasks created over time (last 8 weeks, weekly)
  const createdOverTime: { week: string; created: number; completed: number }[] = [];
  for (let i = 7; i >= 0; i--) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - (i + 1) * 7);
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() - i * 7);

    const created = tasks.filter((t) => {
      const d = new Date(t.createdAt);
      return d >= weekStart && d < weekEnd;
    }).length;

    const completed = tasks.filter((t) => {
      if (t.status !== "done") return false;
      const d = new Date(t.updatedAt);
      return d >= weekStart && d < weekEnd;
    }).length;

    const label = `${weekStart.getMonth() + 1}/${weekStart.getDate()}`;
    createdOverTime.push({ week: label, created, completed });
  }

  // Difficulty breakdown
  const difficultyBreakdown: Record<string, number> = {};
  for (const t of tasks) {
    difficultyBreakdown[t.difficulty] = (difficultyBreakdown[t.difficulty] || 0) + 1;
  }

  return NextResponse.json({
    total: tasks.length,
    done: tasks.filter((t) => t.status === "done").length,
    statusBreakdown,
    categoryBreakdown,
    assigneeBreakdown,
    difficultyBreakdown,
    velocity,
    createdOverTime,
  });
});
