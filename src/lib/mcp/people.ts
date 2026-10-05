import { taskKeyOf } from "@/lib/task-key";
import { pageOf } from "./paging";

type Member = { username: string; fullName?: string };

/** Who a board can hand work to: the name to assign by, and the name to say aloud. Nothing else about them. */
export const memberLines = (members: Member[]) =>
  members.map((member) => ({ username: member.username, fullName: member.fullName ?? "" }));

type MyTask = {
  taskNumber: number;
  title?: string;
  priority?: string;
  status?: string;
  statusLabel?: string;
  statusRole?: string | null;
  dueDate?: string | null;
  project?: { key?: string; name?: string } | null;
};

/**
 * The caller's own open work across boards, in the order the API sends it (most recently changed
 * first). A column whose role is `done` is finished work, so it is left out unless asked for — and the
 * role, not the id, decides: a board that renamed its last column has no column called "done".
 */
export function myTaskLines(tasks: MyTask[], options: { includeDone: boolean; limit: number; offset: number }) {
  const wanted = options.includeDone ? tasks : tasks.filter((task) => task.statusRole !== "done");
  const lines = wanted.slice(options.offset, options.offset + options.limit).map((task) => ({
    key: taskKeyOf(task.project?.key, task.taskNumber),
    title: task.title,
    status: task.status,
    statusRole: task.statusRole ?? null,
    priority: task.priority ?? "medium",
    dueDate: task.dueDate ? String(task.dueDate).slice(0, 10) : null,
    project: task.project?.name ?? null,
  }));
  return pageOf(lines, wanted.length, options.offset);
}

export type AgentRow = {
  name: string;
  description?: string;
  scope: string;
  projectId?: string | null;
  builtIn?: boolean;
  composition?: Record<string, unknown[]>;
};

/**
 * The agents update_task can choose on this board — the project's own, and the ones that belong to no
 * project (the caller's personal ones and the global ones) — with how many steps each runs. An agent
 * with no steps is refused as a hand-over, so the count is what says it is usable.
 */
export function agentLines(agents: AgentRow[], projectId: string) {
  return agents
    .filter((agent) => agent.scope !== "project" || agent.projectId === projectId)
    .map((agent) => ({
      name: agent.name,
      scope: agent.scope,
      description: agent.description ?? "",
      steps: Object.values(agent.composition ?? {}).reduce((n, entries) => n + entries.length, 0),
    }));
}
