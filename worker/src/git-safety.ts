// A linked worktree shares .git with the main clone, and the agent holds Write, so it can drop a
// pre-commit hook or set core.hooksPath and have a later git call execute it. protected-paths
// cannot see any of that: git never tracks anything under .git, so it never reaches a diff.
// bindRepository scans the config once, before the agent runs; these flags are what hold after it.
const SAFE_CONFIG = [
  "core.fsmonitor=false",
  "core.pager=cat",
  "core.hooksPath=/dev/null",
  "credential.helper=",
];

// Measured on this machine, 2026-08-15: `gh auth setup-git` installs its helper in the operator's
// GLOBAL config, so clearing credential.helper would break `git push` on an HTTPS remote — and
// delivery is the one call that has to reach the remote. It keeps the helper and pays for it with
// plantedConfig() below, which refuses to run at all if the agent wrote an executable key.
const DELIVERY_CONFIG = SAFE_CONFIG.filter((entry) => !entry.startsWith("credential."));

export const GIT_SAFE_ENV: Record<string, string> = { GIT_CONFIG_NOSYSTEM: "1" };

function withConfig(config: string[], args: string[]): string[] {
  return [...config.flatMap((entry) => ["-c", entry]), ...args];
}

export function gitArgs(args: string[]): string[] {
  return withConfig(SAFE_CONFIG, args);
}

export function deliveryGitArgs(args: string[]): string[] {
  return withConfig(DELIVERY_CONFIG, args);
}
