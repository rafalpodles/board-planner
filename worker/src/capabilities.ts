/**
 * What this worker can do, said to the server on every request in `X-CP-Capabilities` so that a
 * project is handed to it only when it can run it. A capability is named here once it is true for the
 * whole path, never before: a worker that said it before its run could do it would claim projects it
 * would then run wrongly.
 */
export const MULTI_REPOSITORY = "multi-repository";

/**
 * Whether this worker says it can run several repositories of one project. The run itself exists
 * (`runTaskInRepositories`); what is left before this turns on is the smoke test of a real worker
 * against two repositories and the docs (BP-1073). Until then no project that lists several is ever
 * handed to this worker, because the server hands one only to a worker that says so.
 */
export const SAYS_IT_RUNS_SEVERAL_REPOSITORIES = false;

export function capabilities(): string[] {
  return SAYS_IT_RUNS_SEVERAL_REPOSITORIES ? [MULTI_REPOSITORY] : [];
}
