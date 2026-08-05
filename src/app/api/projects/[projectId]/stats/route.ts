import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { Project } from "@/models/project";
import { User } from "@/models/user";
import { TASK_STATUSES } from "@/types";
import mongoose from "mongoose";

const WEEK_MS = 7 * 86400000;
const WEEKS = 8;

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const projectOid = new mongoose.Types.ObjectId(projectId);
  // One window definition for both the buckets and their labels, so a count can
  // never land under a week it does not belong to
  const now = Date.now();
  const weekStarts = Array.from({ length: WEEKS }, (_, i) => now - (WEEKS - i) * WEEK_MS);
  const since = new Date(weekStarts[0]);

  // Difficulty is an ordinary project field since CP-213. Reading the old column
  // here would report values frozen at the moment CP-214 removed the dual-write.
  const project = await Project.findById(projectId, "customFields").lean();
  const difficultyField = (project?.customFields || []).find(
    (f) => f.name.toLowerCase() === "difficulty"
  );
  const difficultyPath = difficultyField ? `$customFieldValues.${difficultyField._id}` : null;

  const [breakdowns, recentTasks, fieldUsage] = await Promise.all([
    Task.aggregate([
      { $match: { project: projectOid } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          done: { $sum: { $cond: [{ $eq: ["$status", "done"] }, 1, 0] } },
          statusPairs: { $push: "$status" },
          categoryPairs: { $push: "$category" },
          ...(difficultyPath ? { difficultyPairs: { $push: difficultyPath } } : {}),
          assigneePairs: { $push: "$assignee" },
        },
      },
    ]),
    Task.find(
      {
        project: projectOid,
        $or: [
          { createdAt: { $gte: since } },
          { status: "done", updatedAt: { $gte: since } },
        ],
      },
      "createdAt updatedAt status"
    ).lean(),
    // What "used by N tasks" costs before a field is deleted. $objectToArray keeps this
    // to operators MongoDB 4.4 has.
    Task.aggregate([
      { $match: { project: projectOid } },
      { $project: { pairs: { $objectToArray: { $ifNull: ["$customFieldValues", {}] } } } },
      { $unwind: "$pairs" },
      { $match: { "pairs.v": { $nin: [null, "", []] } } },
      { $group: { _id: "$pairs.k", count: { $sum: 1 } } },
    ]),
  ]);

  const customFieldUsage: Record<string, number> = {};
  for (const row of fieldUsage as { _id: string; count: number }[]) {
    customFieldUsage[row._id] = row.count;
  }

  const data = breakdowns[0] || { total: 0, done: 0, statusPairs: [], categoryPairs: [], difficultyPairs: [], assigneePairs: [] };

  // Count breakdowns from arrays
  const statusBreakdown: Record<string, number> = {};
  for (const s of TASK_STATUSES) statusBreakdown[s] = 0;
  for (const s of data.statusPairs) statusBreakdown[s] = (statusBreakdown[s] || 0) + 1;

  const categoryBreakdown: Record<string, number> = {};
  for (const c of data.categoryPairs) categoryBreakdown[c] = (categoryBreakdown[c] || 0) + 1;

  // A project that renamed or removed the field has no split to show, which the
  // chart renders as its empty state rather than as zeroes
  const difficultyBreakdown: Record<string, number> = {};
  for (const d of data.difficultyPairs || []) {
    if (d === null || d === undefined || d === "") continue;
    difficultyBreakdown[String(d)] = (difficultyBreakdown[String(d)] || 0) + 1;
  }

  // assigneePairs is already in hand, so names are the only thing still missing
  const assigneeCounts = new Map<string, number>();
  for (const assignee of data.assigneePairs) {
    const id = assignee ? assignee.toString() : "";
    assigneeCounts.set(id, (assigneeCounts.get(id) || 0) + 1);
  }
  const assigneeIds = [...assigneeCounts.keys()].filter(Boolean);
  const users = assigneeIds.length
    ? await User.find({ _id: { $in: assigneeIds } }, "fullName username").lean()
    : [];
  const nameById = new Map(
    users.map((u) => [u._id.toString(), u.fullName || u.username])
  );

  const assigneeBreakdown: Record<string, number> = {};
  for (const [id, count] of assigneeCounts) {
    const name = id ? nameById.get(id) || "Unknown" : "Unassigned";
    assigneeBreakdown[name] = (assigneeBreakdown[name] || 0) + count;
  }

  const weekIndexOf = (date: Date | undefined): number => {
    if (!date) return -1;
    const index = Math.floor((date.getTime() - weekStarts[0]) / WEEK_MS);
    if (index < 0) return -1;
    // The newest window is closed at the top, so a timestamp at or slightly past
    // `now` — clock skew between the database and this process — still counts
    return Math.min(index, WEEKS - 1);
  };

  const createdPerWeek = new Array(WEEKS).fill(0);
  const completedPerWeek = new Array(WEEKS).fill(0);
  for (const task of recentTasks) {
    const createdIndex = weekIndexOf(task.createdAt);
    if (createdIndex >= 0) createdPerWeek[createdIndex]++;
    if (task.status === "done") {
      const completedIndex = weekIndexOf(task.updatedAt);
      if (completedIndex >= 0) completedPerWeek[completedIndex]++;
    }
  }

  const velocity: { week: string; count: number }[] = [];
  const createdOverTime: { week: string; created: number; completed: number }[] = [];
  for (let i = 0; i < WEEKS; i++) {
    const weekStart = new Date(weekStarts[i]);
    const label = `${weekStart.getMonth() + 1}/${weekStart.getDate()}`;
    velocity.push({ week: label, count: completedPerWeek[i] });
    createdOverTime.push({
      week: label,
      created: createdPerWeek[i],
      completed: completedPerWeek[i],
    });
  }

  return NextResponse.json({
    total: data.total,
    done: data.done,
    statusBreakdown,
    categoryBreakdown,
    assigneeBreakdown,
    difficultyBreakdown,
    velocity,
    createdOverTime,
    customFieldUsage,
  });
});
