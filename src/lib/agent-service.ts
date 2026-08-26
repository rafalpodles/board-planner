import { Agent } from "@/models/agent";
import { AgentBlock } from "@/models/agentBlock";
import {
  AgentComposition,
  ApiAgent,
  ApiAgentRun,
  ApiFleetRun,
  IAgentRun,
  ApiAgentBlock,
  IAgent,
  IAgentBlock,
  IProject,
  IUser,
} from "@/types";
import { brokenProblems, keysOf, normaliseComposition } from "./agent-rules";

/**
 * Why a composition must not be stored, or null. Shared because the create and edit routes had a
 * copy each, and BP-457 was two routes on the same file disagreeing about the same question.
 *
 * The unknown-key arm is not covered by the rules: they no-op on a key that resolves to nothing,
 * while `snapshotFor` returns null for one — so a composition of nonsense strands the tasks
 * pointing at it exactly the way an empty one does.
 */
export async function compositionRefusal(
  composition: AgentComposition
): Promise<{ error: string; problems: string[] } | null> {
  const blocks = (await allBlocks()).map(toApiBlock);
  const lookup = (key: string) => blocks.find((b) => b.key === key);

  const unresolved = [...new Set(keysOf(composition).filter((key) => !key?.trim() || !lookup(key)))];
  if (unresolved.length > 0) {
    const named = unresolved.filter((key) => key?.trim()).join(", ");
    const message = named
      ? `No block called ${named}. The worker refuses a key it cannot resolve, so this would fail on a machine mid-task.`
      : "An entry names no block at all.";
    return { error: message, problems: [message] };
  }

  const broken = brokenProblems(composition, lookup);
  if (broken.length === 0) return null;
  return { error: broken[0].message, problems: broken.map((p) => p.message) };
}

interface AgentDoc extends Omit<IAgent, "project"> {
  project: (IProject & { _id: unknown }) | null;
}

export function toApiAgent(agent: AgentDoc): ApiAgent {
  const project = agent.project && typeof agent.project === "object" ? agent.project : null;
  return {
    _id: String(agent._id),
    name: agent.name,
    description: agent.description,
    scope: agent.scope,
    projectId: project ? String(project._id) : null,
    projectName: project?.name ?? null,
    composition: normaliseComposition(agent.composition),
    builtIn: agent.builtIn,
  };
}

export function toApiBlock(block: IAgentBlock): ApiAgentBlock {
  return {
    _id: String(block._id),
    key: block.key,
    kind: block.kind,
    name: block.name,
    description: block.description,
    builtIn: block.builtIn,
    gateKind: block.gateKind,
    params: block.params ?? {},
    prompt: block.prompt,
    capability: block.capability,
    model: block.model,
    fallbackModel: block.fallbackModel,
    deterministic: block.deterministic,
  };
}

/**
 * Every agent this user may pick: the shipped ones, their own, and those belonging to a project
 * they can reach. A project agent is never offered on another project.
 */
export async function visibleAgents(user: IUser, projectIds: string[]) {
  return Agent.find({
    $or: [
      { scope: "global" },
      { scope: "user", owner: user._id },
      { scope: "project", project: { $in: projectIds } },
    ],
  })
    .populate("project", "name key")
    .sort({ scope: 1, name: 1 })
    .lean();
}

export async function allBlocks() {
  return AgentBlock.find({}).sort({ kind: -1, builtIn: -1, name: 1 }).lean();
}

export function toApiRun(run: IAgentRun): ApiAgentRun {
  const ms = run.finishedAt.valueOf() - run.startedAt.valueOf();
  return {
    _id: String(run._id),
    taskKey: run.taskKey,
    agentName: run.agentName,
    outcome: run.outcome,
    refusedBy: run.refusedBy,
    detail: run.detail,
    // Whole minutes: a run is measured in tens of them, and a decimal reads as precision it has not
    minutes: Math.max(0, Math.round(ms / 60000)),
    costUsd: run.costUsd,
    finishedAt: run.finishedAt.toISOString(),
  };
}

// An unpopulated ref is an ObjectId, which has neither field — so it reads as absent rather than
// serialising an id into a column that exists to name something.
function named(ref: unknown, field: string): string {
  return ref && typeof ref === "object" && field in ref
    ? String((ref as Record<string, unknown>)[field] ?? "")
    : "";
}

export function toFleetRun(run: IAgentRun): ApiFleetRun {
  return {
    ...toApiRun(run),
    projectKey: named(run.project, "key"),
    projectName: named(run.project, "name"),
    workerName: named(run.worker, "name"),
  };
}

const SLUG_MAX = 48;

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX) || "block"
  );
}

/**
 * The client used to derive this and hand it over, which meant two different names could arrive as
 * the same key and come back as a bare 409. Only the server knows what is taken, so only the server
 * can settle it.
 */
export async function freeBlockKey(name: string): Promise<string> {
  const base = slugify(name);
  if (!(await AgentBlock.exists({ key: base }))) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base.slice(0, SLUG_MAX - 3)}-${n}`;
    if (!(await AgentBlock.exists({ key: candidate }))) return candidate;
  }
  throw new Error(`no free key for ${JSON.stringify(name)}`);
}
