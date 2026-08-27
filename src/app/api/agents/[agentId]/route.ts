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
// The cap the two sibling refusals already use — see the columns and categories routes, which
// name task keys for the same "still in use" act. Only the candidates are read: a count answers
// how many are left, so an agent on five thousand tasks costs a count and fifty documents.
const TASKS_NAMED = 10;
const TASK_CANDIDATES = 50;

interface AgentUses {
  /** Everything pointing at the agent, named or not — what decides whether to refuse at all. */
  total: number;
  projects: string[];
  named: string[];
  beyond: number;
  /** True only when every remaining task was seen and none of them may be named. */
  restIsHidden: boolean;
}

/**
 * What still points at this agent. Shared by DELETE and PUT so the two answers cannot drift:
 * emptying an in-use agent is the same act as deleting it.
 */
async function referencesTo(agentId: Types.ObjectId, user: IUser): Promise<AgentUses> {
  const { Project } = await import("@/models/project");
  const { Task } = await import("@/models/task");
  const projects = await Project.find({ "worker.agent": agentId }, "name key").lean();
  const total = await Task.countDocuments({ agent: agentId });
  // By project first: sorting on the number alone lets one board's low numbers starve another's
  // out of the cap for ever, and leaves ties to whatever order the collection happens to be in.
  const candidates = await Task.find({ agent: agentId }, "taskNumber project")
    .sort({ project: 1, taskNumber: 1 })
    .limit(TASK_CANDIDATES)
    .populate("project", "key")
    .lean();

  // Naming a key says more than counting one: it says a board exists and what is on it. A
  // user-scoped agent reaches this with no project check at all (`mayEdit`), and its owner may
  // have lost the board since the agent was written onto the task.
  const readable = new Map<string, boolean>();
  const mayRead = async (projectId: string) => {
    if (!projectId) return false;
    if (!readable.has(projectId)) readable.set(projectId, await check(user, projectId, "access"));
    return readable.get(projectId)!;
  };

  const named: string[] = [];
  let hidden = 0;
  for (const task of candidates) {
    const project = task.project as { _id?: unknown; key?: string } | null;
    if (await mayRead(String(project?._id ?? ""))) {
      if (named.length < TASKS_NAMED) named.push(taskKeyOf(project?.key, task.taskNumber));
    } else {
      hidden += 1;
    }
  }

  const visibleProjects: string[] = [];
  for (const project of projects) {
    // The same reasoning as the tasks: a board's name discloses at least as much as a key
    if (await mayRead(String(project._id))) {
      visibleProjects.push(project.name?.trim() || "a project with no name");
    }
  }

  return {
    // Every reference, visible or not. What may be *named* is scoped to the caller; what blocks
    // the delete is not — otherwise losing sight of a board would be a way to delete its default.
    total: total + projects.length,
    projects: visibleProjects,
    named,
    beyond: total - named.length,
    // Saying "and 3 more" about tasks nobody can reach sends somebody round a loop that cannot
    // end. Only claimed when the whole set was seen and every one of the rest is out of reach.
    restIsHidden: total <= candidates.length && named.length === 0 && hidden > 0,
  };
}

function stillInUse({ projects, named, beyond, restIsHidden }: AgentUses) {
  const parts = [...projects];
  if (named.length > 0) {
    parts.push(`${named.length === 1 && beyond === 0 ? "task" : "tasks"} ${named.join(", ")}${beyond > 0 ? ` and ${beyond} more` : ""}`);
  } else if (beyond > 0) {
    const tasks = `${beyond} task${beyond === 1 ? "" : "s"}`;
    parts.push(restIsHidden ? `${tasks} on boards you cannot open` : tasks);
  }
  // Nothing at all could be described to this caller, and the reference is still real
  if (parts.length === 0) parts.push("something on a board you cannot open");
  return NextResponse.json(
    { error: `Still in use by ${parts.join(", ")}. Point those elsewhere first.` },
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
      if (uses.total > 0) return stillInUse(uses);
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
  if (uses.total > 0) return stillInUse(uses);

  await agent.deleteOne();
  return NextResponse.json({ ok: true });
});
