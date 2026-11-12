import { finalProblem, handoverOf, type HandoverProblem } from "@/lib/handover";
import { missingRolesText, readinessGaps, type ReadinessGap } from "@/lib/project-readiness";
import { projectRepositoryUrl } from "@/lib/repository";
import { getProjectColumns, type AnyColumn } from "@/lib/columns";
import { isWorkerLockedByInstance } from "@/lib/worker-gate";
import { MAX_EXECUTION_ATTEMPTS } from "@/lib/task-service";
import type { ScopedDb } from "@/lib/db-scope";

export interface JudgedTask {
  agent?: unknown;
  assignee?: unknown;
  assignedBy?: unknown;
  pmAssignedFor?: unknown;
  status?: unknown;
  blockedBy?: unknown;
  execution?: { attempts?: number } | null;
}

export type HandoverVerdict = { willRun: true } | { willRun: false; why: string };

/**
 * Why nothing will run this task, or "" when nothing about it is in the way.
 *
 * Deliberately not a promise of the opposite. The claim also needs the assignee to own a live
 * machine serving the repository, which is not knowable here, so "" means "no reason found",
 * never "it will run".
 */
export async function whyItWillNotRun(db: ScopedDb, projectId: string, task: JudgedTask): Promise<string> {
  const project = await db.Project.findById(
    projectId,
    "key columns worker repositoryUrl githubRepo gitlabRepo"
  ).lean();
  if (!project) return "this project is not enabled for workers, so nothing will run it";
  const columns = getProjectColumns(project);
  // Named field by field: the task is a Mongoose document, and spreading one copies its internals
  const judged = {
    agent: task.agent,
    assignee: task.assignee,
    assignedBy: task.assignedBy,
    pmAssignedFor: task.pmAssignedFor,
    status: task.status,
    blockedBy: task.blockedBy,
    attemptsExhausted: (task.execution?.attempts ?? 0) >= MAX_EXECUTION_ATTEMPTS,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handover = handoverOf(judged as any, columns);
  const assignee = usernameOf(task.assignee);
  const final = finalProblem(handover);
  if (final) return whyThisProblem(final, project.key, assignee);
  const reasons = [
    ...(handover.runs ? [] : handover.problems.map((p) => whyThisProblem(p, project.key, assignee))),
    ...readinessGaps({
      repositoryUrl: projectRepositoryUrl(project),
      workerEnabled: !!project.worker?.enabled,
      lockedByInstance: isWorkerLockedByInstance(project.worker),
      columns,
    }).map((gap) => whyThisGap(gap, columns)),
  ];
  return reasons.join("; and ");
}

export async function handoverVerdict(
  db: ScopedDb,
  projectId: string,
  task: JudgedTask
): Promise<HandoverVerdict> {
  const why = await whyItWillNotRun(db, projectId, task);
  return why ? { willRun: false, why } : { willRun: true };
}

function usernameOf(ref: unknown): string {
  if (ref && typeof ref === "object" && "username" in ref) return String(ref.username);
  return "its assignee";
}

function whyThisGap(gap: ReadinessGap, columns: AnyColumn[]): string {
  switch (gap) {
    case "no-repository":
      return "this project names no repository, so no machine can match it";
    case "runs-off":
      return "this project is not enabled for workers, so nothing will run it";
    case "runs-locked":
      return "an admin has locked workers off for this project, so nothing will run it";
    case "missing-columns":
      return `the board has no ${missingRolesText(columns)} column, so no machine can claim from it`;
    default:
      return "";
  }
}

// A switch with no fall-through on purpose: a reason this returns "" for reads as "it will run"
function whyThisProblem({ reason, blockers }: HandoverProblem, key: string, assignee: string): string {
  const who = assignee === "its assignee" ? assignee : `@${assignee}`;
  switch (reason) {
    case "attempts-exhausted":
      return "machines have already tried it as many times as they may, so none will take it again — a person has to finish it";
    case "blocked":
      return `it waits on unfinished blockers (${(blockers ?? []).map((n) => `${key}-${n}`).join(", ")})`;
    case "no-agent":
      return "no agent is named on it, so nothing will run it — a task naming none is one a person is doing";
    case "not-approved-yet":
      return "it is not in a column a machine claims from, so nothing will run it yet";
    case "unassigned":
      return "it ended up assigned to nobody, so nothing will run it";
    case "assigner-unrecorded":
      return `the board has no record of who handed it over, so it waits for ${who} to accept it in the app`;
    case "assigned-by-someone-else":
      return `it waits for ${who} to accept it in the app — a machine runs work somebody else handed over only once its owner accepts it`;
    case "pm-assigned-for-someone-else":
      return `it was handed over on somebody else's instruction, so it waits for ${who} to accept it in the app`;
  }
}
