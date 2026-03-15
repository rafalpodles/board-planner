import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Task } from "@/models/task";
import { TASK_STATUSES } from "@/types";
import mongoose from "mongoose";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const projectOid = new mongoose.Types.ObjectId(projectId);

  // Run aggregations in parallel
  const [breakdowns, weeklyStats] = await Promise.all([
    Task.aggregate([
      { $match: { project: projectOid } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          done: { $sum: { $cond: [{ $eq: ["$status", "done"] }, 1, 0] } },
          statusPairs: { $push: "$status" },
          categoryPairs: { $push: "$category" },
          difficultyPairs: { $push: "$difficulty" },
          assigneePairs: { $push: "$assignee" },
        },
      },
    ]),
    // Weekly created/completed for last 8 weeks
    Task.aggregate([
      {
        $match: {
          project: projectOid,
          $or: [
            { createdAt: { $gte: new Date(Date.now() - 8 * 7 * 86400000) } },
            { status: "done", updatedAt: { $gte: new Date(Date.now() - 8 * 7 * 86400000) } },
          ],
        },
      },
      {
        $facet: {
          created: [
            {
              $group: {
                _id: { $dateTrunc: { date: "$createdAt", unit: "week" } },
                count: { $sum: 1 },
              },
            },
          ],
          completed: [
            { $match: { status: "done" } },
            {
              $group: {
                _id: { $dateTrunc: { date: "$updatedAt", unit: "week" } },
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]),
  ]);

  const data = breakdowns[0] || { total: 0, done: 0, statusPairs: [], categoryPairs: [], difficultyPairs: [], assigneePairs: [] };

  // Count breakdowns from arrays
  const statusBreakdown: Record<string, number> = {};
  for (const s of TASK_STATUSES) statusBreakdown[s] = 0;
  for (const s of data.statusPairs) statusBreakdown[s] = (statusBreakdown[s] || 0) + 1;

  const categoryBreakdown: Record<string, number> = {};
  for (const c of data.categoryPairs) categoryBreakdown[c] = (categoryBreakdown[c] || 0) + 1;

  const difficultyBreakdown: Record<string, number> = {};
  for (const d of data.difficultyPairs) difficultyBreakdown[d] = (difficultyBreakdown[d] || 0) + 1;

  // Assignee breakdown needs user lookup - use a separate aggregation
  const assigneeBreakdown: Record<string, number> = {};
  const assigneeAgg = await Task.aggregate([
    { $match: { project: projectOid } },
    {
      $lookup: {
        from: "users",
        localField: "assignee",
        foreignField: "_id",
        as: "assigneeUser",
        pipeline: [{ $project: { fullName: 1 } }],
      },
    },
    {
      $group: {
        _id: { $ifNull: [{ $arrayElemAt: ["$assigneeUser.fullName", 0] }, "Unassigned"] },
        count: { $sum: 1 },
      },
    },
  ]);
  for (const a of assigneeAgg) assigneeBreakdown[a._id] = a.count;

  // Build weekly arrays
  const now = new Date();
  const weeklyData = weeklyStats[0] || { created: [], completed: [] };
  const createdMap = new Map<number, number>(weeklyData.created.map((w: { _id: Date; count: number }) => [w._id.getTime(), w.count]));
  const completedMap = new Map<number, number>(weeklyData.completed.map((w: { _id: Date; count: number }) => [w._id.getTime(), w.count]));

  const velocity: { week: string; count: number }[] = [];
  const createdOverTime: { week: string; created: number; completed: number }[] = [];

  for (let i = 7; i >= 0; i--) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - (i + 1) * 7);
    const label = `${weekStart.getMonth() + 1}/${weekStart.getDate()}`;

    // Find matching week bucket (truncated to week start)
    let createdCount = 0;
    let completedCount = 0;
    for (const [ts, count] of createdMap) {
      const d = new Date(ts);
      if (d >= weekStart && d < new Date(weekStart.getTime() + 7 * 86400000)) {
        createdCount += count as number;
      }
    }
    for (const [ts, count] of completedMap) {
      const d = new Date(ts);
      if (d >= weekStart && d < new Date(weekStart.getTime() + 7 * 86400000)) {
        completedCount += count as number;
      }
    }

    velocity.push({ week: label, count: completedCount });
    createdOverTime.push({ week: label, created: createdCount, completed: completedCount });
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
  });
});
