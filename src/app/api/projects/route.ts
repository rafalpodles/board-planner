import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth, withAdmin } from "@/lib/middleware";
import { Project } from "@/models/project";
import { sanitizeMcpServers } from "@/lib/pm/config";

export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  const filter =
    user.role === "admin"
      ? {}
      : { _id: { $in: user.allowedProjects || [] } };

  const projects = await Project.find(filter)
    .populate("owner", "username fullName")
    .sort({ createdAt: -1 });
  const sanitized = projects.map((p) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: any = p.toObject();
    obj.githubTokenSet = !!obj.githubToken;
    delete obj.githubToken;
    if (obj.pm) obj.pm.mcpServers = sanitizeMcpServers(obj.pm.mcpServers);
    return obj;
  });
  return NextResponse.json(sanitized);
});

export const POST = withAdmin(async (request, { user }) => {
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
