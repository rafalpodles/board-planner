import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { Agent } from "@/models/agent";
import { Project } from "@/models/project";

// Its own route rather than a field on the worker policy: policy is instance-admin only and travels
// in the assignment payload, and this is neither — a project admin picks it, and it rides the claim.
export const PUT = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  if (!(await check(user, projectId, "admin"))) {
    return NextResponse.json({ error: "Only a project admin can change this" }, { status: 403 });
  }

  const body = await request.json();
  const agentId = typeof body.agentId === "string" ? body.agentId : "";
  if (!agentId) return NextResponse.json({ error: "agentId is required" }, { status: 400 });

  const agent = await Agent.findById(agentId, "scope project").lean();
  if (!agent) return NextResponse.json({ error: "No such agent" }, { status: 404 });
  if (agent.scope === "project" && String(agent.project) !== String(projectId)) {
    return NextResponse.json({ error: "That agent belongs to another project" }, { status: 400 });
  }
  if (agent.scope === "user") {
    return NextResponse.json(
      { error: "A personal agent cannot be a project's default" },
      { status: 400 }
    );
  }

  await Project.updateOne({ _id: projectId }, { $set: { "worker.agent": agentId } });
  return NextResponse.json({ ok: true });
});
