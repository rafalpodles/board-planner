/**
 * What this worker can do, said to the server on every request in `X-CP-Capabilities` so that a
 * project is handed to it only when it can run it. A capability is named here once it is true for the
 * whole path, never before: a worker that said it before its run could do it would claim projects it
 * would then run wrongly.
 */
export const MULTI_REPOSITORY = "multi-repository";

/**
 * Whether a run can take several repositories of one project. The assignments are bound and
 * reported already; the run itself (one worktree per repository, every check on every worktree)
 * arrives with BP-1072, and this turns on with BP-1073.
 */
export const RUNS_SEVERAL_REPOSITORIES = false;

export function capabilities(): string[] {
  return RUNS_SEVERAL_REPOSITORIES ? [MULTI_REPOSITORY] : [];
}
