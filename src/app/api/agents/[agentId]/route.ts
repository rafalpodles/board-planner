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
async function refusalFor(composition: AgentComposition) {
  const refusal = await compositionRefusal(composition);
  return refusal ? NextResponse.json(refusal, { status: 400 }) : null;
}

const TASKS_NAMED = 10;
const TASK_CANDIDATES = 50;

interface AgentUses {
  total: number;
  projects: string[];
  named: string[];
  beyond: number;
  restIsHidden: boolean;
}

async function referencesTo(agentId: Types.ObjectId, user: IUser): Promise<AgentUses> {
  const { Project } = await import("@/models/project");
  const { Task } = await import("@/models/task");
  const projects = await Project.find({ "worker.agent": agentId }, "name key").lean();
  const total = await Task.countDocuments({ agent: agentId });
  const candidates = await Task.find({ agent: agentId }, "taskNumber project")
    .sort({ project: 1, taskNumber: 1 })
    .limit(TASK_CANDIDATES)
    .populate("project", "key")
    .lean();

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
    if (await mayRead(String(project._id))) {
      visibleProjects.push(project.name?.trim() || "a project with no name");
    }
  }

  return {
    total: total + projects.length,
    projects: visibleProjects,
    named,
    beyond: total - named.length,
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

  const uses = await referencesTo(agent._id, user);
  if (uses.total > 0) return stillInUse(uses);

  await agent.deleteOne();
  return NextResponse.json({ ok: true });
});
