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
