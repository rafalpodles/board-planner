import { NextResponse } from "next/server";
import { isValidObjectId, Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { Agent } from "@/models/agent";
import { allBlocks, toApiAgent, toApiBlock } from "@/lib/agent-service";
import { brokenProblems, isRunnable, normaliseComposition } from "@/lib/agent-rules";
import { AgentComposition, IUser } from "@/types";
/**
 * The editor shows these before you save, but the editor is not the only way in. A composition that
 * cannot run must not be stored: the failure would surface on a machine, mid-task, instead of here.
 */
async function refusalFor(composition: AgentComposition) {
  const blocks = await allBlocks();
  const lookup = (key: string) => blocks.map(toApiBlock).find((b) => b.key === key);
  const broken = brokenProblems(composition, lookup);
  if (broken.length === 0) return null;
  return NextResponse.json(
    { error: broken[0].message, problems: broken.map((p) => p.message) },
    { status: 400 }
  );
}

/**
 * What still points at this agent, named the way a person would recognise it. Shared by DELETE and
 * PUT so the two answers cannot drift: emptying an in-use agent is the same act as deleting it.
 */
async function referencesTo(agentId: Types.ObjectId): Promise<string[]> {
  const { Project } = await import("@/models/project");
  const { Task } = await import("@/models/task");
  const projects = await Project.find({ "worker.agent": agentId }, "name").lean();
  const tasks = await Task.countDocuments({ agent: agentId });
  return [
    ...projects.map((p) => p.name),
    ...(tasks > 0 ? [`${tasks} task${tasks === 1 ? "" : "s"}`] : []),
  ];
}

function stillInUse(uses: string[]) {
  return NextResponse.json(
    { error: `Still in use by ${uses.join(", ")}. Point those elsewhere first.` },
    { status: 409 }
  );
}

async function mayEdit(user: IUser, agent: { scope: string; owner: unknown; project: unknown }) {
  if (agent.scope === "user") return String(agent.owner) === String(user._id);
  if (agent.scope === "project") return check(user, String(agent.project), "admin");
  return user.role === "admin";
}

export const PUT = withAuth(async (request, { params, user }) => {
  const { agentId } = await params;
  // An id that is not one reaches Mongoose as a CastError and answers 500; this is a 404.
  if (!isValidObjectId(agentId)) return NextResponse.json({ error: "No such record" }, { status: 404 });
  await connectDB();

  const agent = await Agent.findById(agentId);
  if (!agent) return NextResponse.json({ error: "No such agent" }, { status: 404 });

  if (!(await mayEdit(user, agent))) {
    return NextResponse.json({ error: "Not yours to change" }, { status: 403 });
  }

  const body = await request.json();
  if (typeof body.name === "string" && body.name.trim()) agent.name = body.name.trim();
  if (typeof body.description === "string") agent.description = body.description.trim();
  if (body.composition) {
    const composition = normaliseComposition(body.composition);
    const refusal = await refusalFor(composition);
    if (refusal) return refusal;
    // Emptying an agent something points at is the same act as deleting it, and DELETE refuses.
    // Left through, the tasks keep an agent no claim can resolve: each is handed straight back and
    // sorts first on the next poll, so the rest of the board queues behind it (BP-457). An agent
    // nothing points at stays a draft, which is what makes this a check about references.
    if (!isRunnable(composition)) {
      const uses = await referencesTo(agent._id);
      if (uses.length > 0) return stillInUse(uses);
    }
    agent.composition = composition;
  }

  await agent.save();

  const saved = await Agent.findById(agent._id).populate("project", "name key").lean();
  return NextResponse.json(toApiAgent(saved as never));
});

export const DELETE = withAuth(async (_request, { params, user }) => {
  const { agentId } = await params;
  // An id that is not one reaches Mongoose as a CastError and answers 500; this is a 404.
  if (!isValidObjectId(agentId)) return NextResponse.json({ error: "No such record" }, { status: 404 });
  await connectDB();

  const agent = await Agent.findById(agentId);
  if (!agent) return NextResponse.json({ error: "No such agent" }, { status: 404 });
  if (agent.builtIn) {
    return NextResponse.json({ error: "A built-in agent cannot be deleted" }, { status: 400 });
  }
  if (!(await mayEdit(user, agent))) {
    return NextResponse.json({ error: "Not yours to delete" }, { status: 403 });
  }

  // A task pointing at a deleted agent is claimed and then handed straight back, three times,
  // before it escalates; a project pointing at one offers a first choice that does not exist.
  // Both are better refused here.
  const uses = await referencesTo(agent._id);
  if (uses.length > 0) return stillInUse(uses);

  await agent.deleteOne();
  return NextResponse.json({ ok: true });
});
