import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Project } from "@/models/project";

export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  const filter =
    user.role === "admin"
      ? {}
      : { _id: { $in: user.allowedProjects } };

  const projects = await Project.find(filter)
    .populate("owner", "username fullName")
    .sort({ createdAt: -1 });
  return NextResponse.json(projects);
});

export const POST = withAuth(async (request, { user }) => {
  await connectDB();
  const body = await request.json();
  const { name, key, description } = body;

  if (!name || !key) {
    return NextResponse.json(
      { error: "name and key are required" },
      { status: 400 }
    );
  }

  const project = await Project.create({
    name,
    key,
    description: description || "",
    owner: user._id,
  });

  const populated = await project.populate("owner", "username fullName");
  return NextResponse.json(populated, { status: 201 });
});
