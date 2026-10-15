import type { ScopedDb } from "@/lib/db-scope";
import type { ApiFleetMachine, FleetState, IUser, IWorker, MachineState } from "@/types";
import { check } from "@/lib/grants";
import { machineCondition } from "@/lib/worker-service";
import { claimingMachineIds, isHeldByPlan } from "@/lib/machine-limit";
import { toApiExecution } from "@/lib/task-service";
import { runStateOf } from "@/lib/run-state";

type HeldTask = {
  _id: unknown;
  taskNumber: number;
  title: string;
  project: { _id: unknown; key?: string } | null;
  execution?: Parameters<typeof toApiExecution>[0];
};

const AT_REST: Partial<Record<MachineState, FleetState>> = {
  disabled: "off",
  stale: "offline",
  paused: "paused",
  stopped: "paused",
};

export function fleetState(machine: MachineState, held: HeldTask | undefined): FleetState {
  if (held && machine !== "disabled" && machine !== "stale") {
    return runStateOf(toApiExecution(held.execution)) === "quiet" ? "quiet" : "running";
  }
  return AT_REST[machine] ?? "idle";
}

// A machine reaches what its owner reaches, so an administrator sees every one and anybody else their own
export async function fleetFor(db: ScopedDb, user: IUser): Promise<ApiFleetMachine[]> {
  const workers = await db.Worker.find(
    user.role === "admin" ? {} : { owner: user._id },
    "_id name host enabled lastSeenAt preflight command commandIssuedAt commandAckedAt halt owner"
  )
    .sort({ name: 1, host: 1 })
    .lean<IWorker[]>();
  if (workers.length === 0) return [];

  const ids = workers.map((w) => String(w._id));
  const [claiming, tasks] = await Promise.all([
    claimingMachineIds(db),
    db.Task.find({ "execution.workerId": { $in: ids }, "execution.runId": { $nin: [null, ""] } })
      // A machine killed mid-run can still hold an abandoned task beside the one it is running
      .sort({ "execution.startedAt": -1 })
      .select("_id taskNumber title project execution")
      .populate("project", "key")
      .lean<HeldTask[]>(),
  ]);

  const heldBy = new Map<string, HeldTask>();
  for (const task of tasks) {
    const workerId = task.execution?.workerId ?? "";
    if (workerId && !heldBy.has(workerId)) heldBy.set(workerId, task);
  }

  const visible = new Map<string, boolean>();
  for (const task of heldBy.values()) {
    const projectId = task.project ? String(task.project._id) : "";
    if (projectId && !visible.has(projectId)) visible.set(projectId, await check(db, user, projectId, "access"));
  }

  const now = new Date();
  return workers.map((worker) => {
    const held = heldBy.get(String(worker._id));
    const condition = machineCondition(worker, now, isHeldByPlan(worker, claiming));
    const state = fleetState(condition.state, held);
    const machine: ApiFleetMachine = { _id: String(worker._id), name: worker.name, state };
    if (!held || (state !== "running" && state !== "quiet")) return machine;
    const projectKey = held.project?.key ?? "";
    const seen = !!held.project && visible.get(String(held.project._id)) === true && !!projectKey;
    machine.task = seen
      ? {
          key: `${projectKey}-${held.taskNumber}`,
          title: held.title,
          ...(held.execution?.phase ? { phase: held.execution.phase } : {}),
          projectKey,
          taskNumber: held.taskNumber,
        }
      : { hidden: true };
    return machine;
  });
}
