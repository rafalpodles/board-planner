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
//
// GIT_NO_REPLACE_OBJECTS is here rather than in SAFE_CONFIG because it is an env-only knob (no -c
// equivalent). refs/replace/<sha> is a file the agent can write directly, and it substitutes what
// cat-file/diff/show read back for a sha, so a gate can review one tree while a different one is
// what actually gets pushed (BP-382).
//
// It reaches the history walk too, which an earlier version of this comment denied: measured,
// `rev-list --count HEAD` reports 2 where the true answer is 3 with a replace ref in place, and 1
// after `git replace --graft`. provenance.ts's `rev-list <baseSha>..HEAD` is exactly such a walk,
// so it is this variable — not any property of rev-list — that makes the provenance check mean
// anything. Do not drop it there on the strength of the sentence that used to be here.
export const GIT_SAFE_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
};

function withConfig(config: string[], args: string[]): string[] {
  return [...config.flatMap((entry) => ["-c", entry]), ...args];
}

export function gitArgs(args: string[]): string[] {
  return withConfig(SAFE_CONFIG, args);
}
