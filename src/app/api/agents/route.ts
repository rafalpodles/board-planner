import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { accessibleProjectIds, check } from "@/lib/grants";
import { Agent } from "@/models/agent";
import { Project } from "@/models/project";
import { normaliseComposition, toApiAgent, visibleAgents } from "@/lib/agent-service";

export const GET = withAuth(async (_request, { user }) => {
  await connectDB();

  // null means every project, which is what an instance admin gets
  const scoped = await accessibleProjectIds(user);
  const projectIds =
    scoped ?? (await Project.find({}, "_id").lean()).map((p) => String(p._id));

  const agents = await visibleAgents(user, projectIds);
  return NextResponse.json(agents.map((a) => toApiAgent(a as never)));
});

export const POST = withAuth(async (request, { user }) => {
  await connectDB();
  const body = await request.json();

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "A name is required" }, { status: 400 });

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (projectId) {
    // A project agent runs on that project's repository, so authoring one is an administrative act
    // on the project rather than something any member may do.
    if (!(await check(user, projectId, "admin"))) {
      return NextResponse.json(
        { error: "Only a project admin can add an agent to a project" },
        { status: 403 }
      );
    }
  }

  const agent = await Agent.create({
    name,
    description: typeof body.description === "string" ? body.description.trim() : "",
    scope: projectId ? "project" : "user",
    owner: projectId ? null : user._id,
    project: projectId || null,
    composition: normaliseComposition(body.composition),
    builtIn: false,
  });

  const created = await Agent.findById(agent._id).populate("project", "name key").lean();
  return NextResponse.json(toApiAgent(created as never), { status: 201 });
});
