import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";

export const POST = withProjectOwner(async (request, { params }) => {
  await connectDB();
  const { projectId } = await params;
  const { name } = await request.json();

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const server = (project.pm?.mcpServers ?? []).find((s) => s.name === name);
  if (!server || !server.oauth) {
    return NextResponse.json({ error: `No OAuth connection named "${name}"` }, { status: 404 });
  }

  server.oauth.accessToken = "";
  server.oauth.refreshToken = "";
  server.oauth.expiresAt = null;
  server.oauth.status = "unconfigured";
  project.markModified("pm.mcpServers");
  await project.save();

  return NextResponse.json({ ok: true });
});
