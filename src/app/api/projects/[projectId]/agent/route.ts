import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectAccess } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { Agent } from "@/models/agent";
import { Project } from "@/models/project";
import { isRunnable, normaliseComposition } from "@/lib/agent-rules";

// Its own route rather than a field on the worker policy: policy is instance-admin only and travels
// in the assignment payload, and this is neither — a project admin picks it. Since BP-358 it does
// not ride the claim either: the task's own agent is the only thing a claim resolves, and this is
// the agent the task picker offers first.
export const PUT = withProjectAccess(async (request, { params, user }) => {
  const { projectId } = await params;
  await connectDB();

  if (!(await check(user, projectId, "admin"))) {
    return NextResponse.json({ error: "Only a project admin can change this" }, { status: 403 });
  }

  const body = await request.json();
  const raw = (body as { agentId?: unknown }).agentId;
  // Absent, null, or the wrong type is a malformed request and not a request to clear. Coercing
  // it to "" made `{}` and a typo'd key answer 200 and null the field — "did not say" and
  // "asked to clear" cannot be the same wire message on a route an API token can reach.
  if (typeof raw !== "string") {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }
  const agentId = raw;

  // The empty string, and only that, clears it. A default that could be set and never unset left
  // a project stuck with a suggestion it had outgrown, and the picker with no way back (BP-458).
  if (!agentId) {
    await Project.updateOne({ _id: projectId }, { $set: { "worker.agent": null } });
    return NextResponse.json({ ok: true });
  }

  const agent = await Agent.findById(agentId, "scope project composition").lean();
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

  if (!isRunnable(normaliseComposition(agent.composition))) {
    return NextResponse.json(
      { error: "That agent has nothing in it yet, so offering it first would suggest one that cannot run" },
      { status: 400 }
    );
  }

  await Project.updateOne({ _id: projectId }, { $set: { "worker.agent": agentId } });
  return NextResponse.json({ ok: true });
});
