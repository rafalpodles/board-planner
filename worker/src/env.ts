// Every subprocess the worker spawns either runs agent-written code or runs inside a tree the
// agent controls, so the child environment is built from an allowlist. A denylist cannot work:
// it has to name every secret that will ever exist in the parent, and CP_API_TOKEN alone would
// let the agent write to the board as the operator.
const ALLOWED = [
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
];

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
