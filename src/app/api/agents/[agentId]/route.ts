import { NextResponse } from "next/server";
import { isValidObjectId, Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { check } from "@/lib/grants";
import { Agent } from "@/models/agent";
import { compositionRefusal, toApiAgent } from "@/lib/agent-service";
import { taskKeyOf } from "@/lib/task-key";
import { isRunnable, normaliseComposition } from "@/lib/agent-rules";
import { AgentComposition, IUser } from "@/types";
// The editor shows these before you save, but the editor is not the only way in.
async function refusalFor(composition: AgentComposition) {
  const refusal = await compositionRefusal(composition);
  return refusal ? NextResponse.json(refusal, { status: 400 }) : null;
}

/**
 * What still points at this agent, named the way a person would recognise it. Shared by DELETE and
 * PUT so the two answers cannot drift: emptying an in-use agent is the same act as deleting it.
 */
// Enough to act on without a sentence nobody reads. Past it the count says how many are left, and
// the next refusal names the next few — retiring an agent walks down the list.
const TASKS_NAMED = 5;

async function referencesTo(agentId: Types.ObjectId, user: IUser): Promise<string[]> {
  const { Project } = await import("@/models/project");
  const { Task } = await import("@/models/task");
  const projects = await Project.find({ "worker.agent": agentId }, "name").lean();
  // Keys, not a count: "12 tasks" told somebody to point twelve things elsewhere and gave them no
  // way to find one of them (BP-482).
  const tasks = await Task.find({ agent: agentId }, "taskNumber project")
    .sort({ taskNumber: 1 })
    .populate("project", "key")
    .lean();

  // Naming a key says more than counting one — it says a board exists and what is on it. A
  // user-scoped agent reaches this with no project check at all (`mayEdit`), and its owner may
  // have lost the board since the agent was written onto the task. Those fold into the count.
  const readable = new Map<string, boolean>();
  const named: string[] = [];
  let beyond = 0;
  for (const task of tasks) {
    const project = task.project as { _id?: unknown; key?: string } | null;
    const projectId = String(project?._id ?? "");
    if (!readable.has(projectId)) {
      readable.set(projectId, projectId ? await check(user, projectId, "access") : false);
    }
    if (readable.get(projectId) && named.length < TASKS_NAMED) {
      named.push(taskKeyOf(project?.key, task.taskNumber));
    } else {
      beyond += 1;
    }
  }

  return [
    // A board with no name still has to be nameable in a sentence
    ...projects.map((p) => p.name?.trim() || "a project with no name"),
    ...namedTasks(named, beyond),
  ];
}

/** The task half of the sentence: what can be named, then how many are left. */
function namedTasks(named: string[], beyond: number): string[] {
  if (named.length === 0) {
    return beyond > 0 ? [`${beyond} task${beyond === 1 ? "" : "s"}`] : [];
  }
  return [beyond > 0 ? `${named.join(", ")} and ${beyond} more` : named.join(", ")];
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
    // Same act as deleting it, which DELETE refuses. An agent nothing points at stays a draft.
    if (!isRunnable(composition)) {
      const uses = await referencesTo(agent._id, user);
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
  const uses = await referencesTo(agent._id, user);
  if (uses.length > 0) return stillInUse(uses);

  await agent.deleteOne();
  return NextResponse.json({ ok: true });
});
