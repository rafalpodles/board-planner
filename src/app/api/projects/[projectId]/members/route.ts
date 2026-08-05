import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { User } from "@/models/user";

export const GET = withProjectOwner(async (_request, { params }) => {
  await connectDB();
  const { projectId } = await params;

  const users = await User.find({
    $or: [{ role: "admin" }, { allowedProjects: projectId }],
  })
    .select("username fullName role")
    .sort({ username: 1 });

  return NextResponse.json(users);
});
