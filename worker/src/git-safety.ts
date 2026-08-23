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

// Delivery does not go through here: it carries GH_TOKEN and has to reach the remote, so it
// hardens in the environment instead (GIT_CONFIG_* in delivery.ts), which also covers the git that
// `gh` shells out to and can clear credential.helper without losing the one `gh` installs.
export const GIT_SAFE_ENV: Record<string, string> = { GIT_CONFIG_NOSYSTEM: "1" };

function withConfig(config: string[], args: string[]): string[] {
  return [...config.flatMap((entry) => ["-c", entry]), ...args];
}

// git reads an option-shaped positional as an option, and none of this package's calls ever mean
// one: `git diff --numstat '--output=/tmp/pwned...HEAD'` exits 0 and writes that file. `--` is
// where a caller has already said "everything after this is a positional", so it is the one place
// the rule can be enforced once for every call site instead of at each sink. Exported because
// delivery.ts hardens through the environment rather than through gitArgs and still has a
// positional of its own.
export function refuseOptionShapedPositionals(args: string[]): string[] {
  const separator = args.indexOf("--");
  if (separator === -1) return args;
  const offender = args.slice(separator + 1).find((arg) => arg.startsWith("-"));
  if (offender !== undefined) {
    throw new Error(
      `refusing git argument ${JSON.stringify(offender)}: git reads a leading dash as an option`
    );
  }
  return args;
}

export function gitArgs(args: string[]): string[] {
  return withConfig(SAFE_CONFIG, refuseOptionShapedPositionals(args));
}
