// Every subprocess the worker spawns either runs agent-written code or runs inside a tree the
// agent controls, so the child environment is built from an allowlist. A denylist cannot work:
// it has to name every secret that will ever exist in the parent, and CP_API_TOKEN alone would
// let the agent write to the board as the operator.
// Exported so the behavioural tripwire (child-env.behavioral.integration.test.ts) can assert
// against the real list rather than a hand-copied one that would drift from it (BP-310).
export const ALLOWED = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
] as const;

/**
 * Whether the operator has accepted running the agent with nothing confining its writes (BP-349).
 *
 * Read here rather than in sandbox.ts because this module owns what of the worker's own environment
 * is allowed to matter — the same reason the allowlist above lives here. An environment variable
 * rather than a worker policy field: policy comes down from the server, and a setting that turns
 * the sandbox off must not be reachable by anything the agent can reach. Deliberately absent from
 * ALLOWED, so the agent is never told whether it is confined.
 */
export const UNCONFINED_ESCAPE_HATCH = "CP_ALLOW_UNCONFINED_AGENT";

export function unconfinedAgentAllowed(source: NodeJS.ProcessEnv = process.env): boolean {
  const value = source[UNCONFINED_ESCAPE_HATCH]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function childEnv(
  alsoAllow: string[] = [],
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...ALLOWED, ...alsoAllow]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// On a clone with `core.ignoreStat=true` git marks what it checks out or stages assume-unchanged,
// which worktree-pin.ts refuses a run over; the agent's own `git add` must not do it by config
// (BP-794). Environment config outranks the repository's own.
export const AGENT_GIT_CONFIG: NodeJS.ProcessEnv = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.ignoreStat",
  GIT_CONFIG_VALUE_0: "false",
};

/** `childEnv` for a process that runs agent-written code, or the agent itself, in the worktree. */
export function agentEnv(alsoAllow: string[] = [], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...childEnv(alsoAllow, source), ...AGENT_GIT_CONFIG };
}

/**
 * Where the npm gates keep the cache `npm ci` needs (BP-608).
 *
 * Read here for the reason everything else in this module is: this file owns what of the worker's
 * own environment is allowed to matter. Deliberately absent from ALLOWED — the gates pass the path
 * to npm as `npm_config_cache`, and nothing the agent runs is told where the operator put it.
 */
export const NPM_CACHE_OVERRIDE = "CP_NPM_CACHE";

export function npmCacheOverride(source: NodeJS.ProcessEnv = process.env): string {
  return source[NPM_CACHE_OVERRIDE]?.trim() ?? "";
}

/** The temp directory a confined command may write to, when the operator has moved it. */
export function tempDirOverride(source: NodeJS.ProcessEnv = process.env): string {
  return source.TMPDIR?.trim() ?? "";
}
