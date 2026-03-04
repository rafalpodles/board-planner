import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { Sprint } from "@/models/sprint";
import { Task } from "@/models/task";

export const GET = withProjectAccess(async (_request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const sprints = await Sprint.find({ project: projectId })
    .sort({ startDate: -1 })
    .lean();

  // Attach task counts
  const sprintIds = sprints.map((s) => s._id);
  if (sprintIds.length === 0) return NextResponse.json([]);

  const counts = await Task.aggregate([
    { $match: { project: new mongoose.Types.ObjectId(projectId), sprint: { $in: sprintIds } } },
    {
      $group: {
        _id: "$sprint",
        total: { $sum: 1 },
        done: { $sum: { $cond: [{ $eq: ["$status", "done"] }, 1, 0] } },
      },
    },
  ]);

  const countMap = new Map(counts.map((c) => [String(c._id), c]));

  const result = sprints.map((s) => {
    const c = countMap.get(String(s._id));
    return {
      ...s,
      taskCount: c?.total || 0,
      doneCount: c?.done || 0,
    };
  });

  return NextResponse.json(result);
});

export const POST = withProjectAccess(async (request, { params }) => {
  const { projectId } = await params;
  await connectDB();

  const body = await request.json();

  if (!body.name || !body.startDate || !body.endDate) {
    return NextResponse.json(
      { error: "Name, startDate, and endDate are required" },
      { status: 400 }
    );
  }

  const sprint = await Sprint.create({
    project: projectId,
    name: body.name,
    startDate: new Date(body.startDate),
    endDate: new Date(body.endDate),
    goal: body.goal || "",
    status: body.status || "planned",
  });

  return NextResponse.json(sprint, { status: 201 });
});
