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
