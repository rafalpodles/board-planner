// Kept free of imports so client components can ask the same question the server does.

export interface ProjectWorkerGateFields {
  enabled?: boolean;
  lockedByInstance?: boolean;
}

// Every runtime path asks this rather than reading worker.enabled directly: the owner sets
// `enabled`, an instance admin sets the lock, and the lock has to win in every entry point.
export function projectRunsWorkers<T extends ProjectWorkerGateFields>(
  worker: T | undefined | null
): worker is T {
  return !!worker?.enabled && !worker.lockedByInstance;
}

// Mongo equivalent of projectRunsWorkers, for queries that select projects in bulk
export const PROJECT_RUNS_WORKERS_QUERY = {
  "worker.enabled": true,
  "worker.lockedByInstance": { $ne: true },
};

export function isWorkerLockedByInstance(worker: ProjectWorkerGateFields | undefined | null): boolean {
  return !!worker?.lockedByInstance;
}

export const WORKERS_LOCKED_MESSAGE =
  "An instance admin has locked workers off for this project";
