import { childEnv } from "./env.js";

// A linked worktree shares .git with the main clone, and the agent holds Write, so it can drop a
// pre-commit hook or set core.hooksPath and have a later git call execute it. protected-paths
// cannot see any of that: git never tracks anything under .git, so it never reaches a diff.
// bindRepository scans the config once, before the agent runs; these flags are what hold after it.
const SAFE_CONFIG = [
  "core.fsmonitor=false",
  "core.pager=cat",
  "core.hooksPath=/dev/null",
  "credential.helper=",
  // Every rule the gates apply is about a path, and by default git QUOTES a path carrying any
  // non-ASCII byte: `.github/workflows/cié.yml` is printed as `".github/workflows/ci\303\251.yml"`,
  // quotes included. Measured on git 2.50.1 — against that string every one of protected-paths'
  // regexes answers false, because `(^|\/)` dies on the leading quote and `\.ya?ml$` on the
  // trailing one. GitHub runs the file all the same. Here rather than at the one call site,
  // because a path a rule cannot read is the same hazard wherever it is read (BP-381).
  "core.quotePath=false",
  // `commit.gpgSign=true` plus `gpg.program` in the checkout's own config makes `git commit` run
  // that program — measured on git 2.50.1 under exactly this environment, and it is neither a hook
  // nor a filter, so nothing above catches it. `gpg.format=ssh` reaches the same place through
  // `gpg.ssh.defaultKeyCommand`. Signing is not something this worker does, so the mechanism is
  // turned off rather than the programs enumerated: the key list in repos.ts names them too, but
  // that list is a scan and this is the sink (BP-516 review).
  "commit.gpgSign=false",
  // git's user-level ignore list is `core.excludesFile`, and with no config file to set it git
  // still reads `$XDG_CONFIG_HOME/git/ignore` — `$HOME/.config/git/ignore` — which `childEnv()`
  // forwards HOME for and which the agent can write. A path named there is invisible to
  // `git status --porcelain` AND to `git add --all`, so a file written into the worktree and
  // ignored there reads as a clean tree, reaches no diff and no gate, and is still run by the test
  // gate. The repository's own `.gitignore` is a separate list and is untouched. So is
  // `.git/info/exclude` — and that one is the same hazard with the same owner as `.git/config`:
  // untracked, shared with the main clone, writable by the agent, and reaching no diff. Telling it
  // from the repository's own list needs `check-ignore -v`, which is BP-640.
  "core.excludesFile=/dev/null",
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

// One spelling of "read no global config at all", shared with delivery.ts so the two cannot drift.
export const NO_GLOBAL_CONFIG = "/dev/null";

/**
 * The environment for every git call this worker makes, with one exception named below: the read
 * of the operator's own identity, which is the one question only that file can answer.
 *
 * `~/.gitconfig` is the agent's file as much as the repository's own: `childEnv()` forwards HOME
 * because the CLI authenticates from its session there, and BP-349 says the agent's Write reaches
 * it. A `filter.<name>.clean` defined there runs on `git status` and `git add`, and a
 * `filter.<name>.smudge` runs when the review gate checks the change out — with nothing planted
 * inside the repository at all, which is what makes the local-scope scan close to decorative on its
 * own. Measured on git 2.50.1 (BP-504 for the checkout, BP-516 for the rest).
 *
 * The diff is defence in depth rather than a hole this closes: every `git diff` in diff.ts already
 * passes `--no-ext-diff --no-textconv`, so neither a global driver nor a global textconv could
 * substitute a patch. Those are flags a call added later has to remember; this environment is not.
 *
 * It takes the commit identity with it, which is why `commitAll` is handed one resolved before the
 * agent ran rather than reading it at commit time.
 */
export function localGitEnv(
  alsoAllow: string[] = [],
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...childEnv(alsoAllow),
    // The caller's own variables go in the middle: a call site that needs one — the commit
    // identity, the GIT_DIR that keeps a base lookup out of every repository — must not be able to
    // reach the hardening on its way past, and a tripwire over the source cannot see a key that
    // arrives inside an object.
    ...extra,
    ...GIT_SAFE_ENV,
    GIT_CONFIG_GLOBAL: NO_GLOBAL_CONFIG,
  };
}

/**
 * The one environment that still reads the operator's own config, for the one question only that
 * file can answer: which name and address their commits carry. It resolves a value and never runs
 * one — `git var GIT_AUTHOR_IDENT` reads config and prints an ident, `gitArgs` pins the pager at
 * the command line where it outranks any config file, and signing is off there too. Every other
 * call goes through `localGitEnv`, and the tripwire in git-safety.test.ts is what keeps that true —
 * it checks the call, not just the file.
 */
export function operatorGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // Caller's own in the middle, hardening last — the same discipline as `localGitEnv`, so the one
  // call that is allowed to read that file still cannot decide anything else about what git does.
  return { ...childEnv(), ...extra, ...GIT_SAFE_ENV };
}

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
