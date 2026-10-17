/**
 * What this worker can do, said to the server on every request in `X-CP-Capabilities` so that a
 * project is handed to it only when it can run it. A capability is named here once it is true for the
 * whole path, never before: a worker that said it before its run could do it would claim projects it
 * would then run wrongly.
 */
export const MULTI_REPOSITORY = "multi-repository";

/**
 * Whether this worker says it can run several repositories of one project: `runTaskInRepositories`
 * exists, is exercised against real git by `pipeline-several.integration.test.ts` and, in CI, by a
 * real worker carrying a task through two repositories (e2e/smoke/worker.smoke.ts). It turns false
 * only to take the capability back, in which case the server stops handing such a project to this
 * worker.
 */
export const SAYS_IT_RUNS_SEVERAL_REPOSITORIES = true;

export const CAPABILITIES_HEADER = "X-CP-Capabilities";

export function capabilities(says: boolean = SAYS_IT_RUNS_SEVERAL_REPOSITORIES): string[] {
  return says ? [MULTI_REPOSITORY] : [];
}

/** Spread into the headers of every request to the server, next to `X-CP-Protocol` */
export function capabilityHeaders(says: boolean = SAYS_IT_RUNS_SEVERAL_REPOSITORIES): Record<string, string> {
  const named = capabilities(says);
  return named.length > 0 ? { [CAPABILITIES_HEADER]: named.join(",") } : {};
}
