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

// The coding CLIs preflight found usable, named `agent-<id>` to the server (BP-987). Empty until the
// first preflight has answered, so a machine says nothing about what it has not yet looked for.
let reportedAgents: string[] = [];

/** Called with preflight's answer; the server then offers this machine tasks whose agent runs on these */
export function reportAgents(agents: readonly string[]): void {
  reportedAgents = [...agents];
}

export function capabilities(
  says: boolean = SAYS_IT_RUNS_SEVERAL_REPOSITORIES,
  agents: readonly string[] = reportedAgents
): string[] {
  return [...(says ? [MULTI_REPOSITORY] : []), ...agents.map((agent) => `agent-${agent}`)];
}

/** Spread into the headers of every request to the server, next to `X-CP-Protocol` */
export function capabilityHeaders(
  says: boolean = SAYS_IT_RUNS_SEVERAL_REPOSITORIES,
  agents: readonly string[] = reportedAgents
): Record<string, string> {
  const named = capabilities(says, agents);
  return named.length > 0 ? { [CAPABILITIES_HEADER]: named.join(",") } : {};
}
