import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  gitArgs,
  GIT_SAFE_ENV,
  localGitEnv,
  NO_GLOBAL_CONFIG,
  operatorGitEnv,
} from "./git-safety.js";

describe("gitArgs", () => {
  it("disables the hook path, so a hook the agent wrote never runs", () => {
    expect(gitArgs(["status"])).toContain("core.hooksPath=/dev/null");
  });

  it("keeps what the call sites already disabled by hand", () => {
    const args = gitArgs(["status"]);
    expect(args).toContain("core.pager=cat");
    expect(args).toContain("core.fsmonitor=false");
  });

  it("keeps the caller's arguments last, so the subcommand stays first", () => {
    expect(gitArgs(["push", "--force-with-lease"]).slice(-2)).toEqual([
      "push",
      "--force-with-lease",
    ]);
  });

  // The split from deliveryGitArgs is the whole point of the module, and only one half of it was
  // asserted: removing this from SAFE_CONFIG left every test green
  it("clears the credential helper on every call that is not delivery", () => {
    expect(gitArgs(["status"])).toContain("credential.helper=");
  });

  it("refuses the system config", () => {
    expect(GIT_SAFE_ENV.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  // BP-327. `--` is where a caller says "everything after this is a positional", so it is the one
  // place the rule can be applied once for every call site rather than at each sink.
  it("refuses an option-shaped argument after the -- separator", () => {
    expect(() => gitArgs(["push", "--", "--receive-pack=touch /tmp/pwned"])).toThrow(
      /leading dash/i
    );
  });

  it("leaves options before the separator alone", () => {
    expect(() => gitArgs(["add", "--all", "--"])).not.toThrow();
    expect(() => gitArgs(["worktree", "add", "-B", "bp-1/x", "--", "/root/bp-1"])).not.toThrow();
  });
});

/**
 * The same shape as child-env.contract.test.ts: a tripwire over the source, not a test of
 * behaviour. When it fails, build the environment with `localGitEnv()` and name whatever extra
 * variable that one call genuinely needs.
 *
 * It reads the source as it is, comments and all. The version before this stripped comments first,
 * and a `//` line in repos.ts carrying `/private/*` opened a block comment the regex closed 183
 * lines later — taking the config scan, the one module this whole change is about, out of the scan
 * entirely. Measured: an unhardened git call added there was invisible to all four assertions. A
 * comment that happens to contain `run("git"` now fails this test instead, which is the direction
 * to fail in.
 */
const MAY_COMPOSE_A_GIT_ENVIRONMENT = ["delivery.ts", "git-safety.ts"];

// commitAll's identity read is the one call that still reads the operator's own config, and there
// is nothing else it could be for: a second user would mean a git call the scan cannot vouch for.
const MAY_READ_THE_OPERATORS_CONFIG = ["commit.ts"];

/**
 * Every file that spawns git, pinned by name. A scan that stops seeing one of them is a scan that
 * has stopped working, and that failure is silent in every other assertion here — the rules below
 * all iterate over what the scan found. Adding a call site to a new file is a deliberate act;
 * adding it to this list is how you say so.
 */
const FILES_THAT_RUN_GIT = [
  "commit.ts",
  "decisions.ts",
  // The push, through its own helper — exempt from the rule below and not from this one: a file
  // that stops spawning git is as much a change as one that starts.
  "delivery.ts",
  "diff.ts",
  "gates/review.ts",
  "pipeline.ts",
  "provenance.ts",
  "repos.ts",
  "workspace.ts",
];

const RUNS_GIT = /run\(\s*"git"/g;

// The helper has to be what the call's `env` is built FROM, not a name that happens to appear in
// the window. Reading the source as it is means a comment inside a call's window would otherwise
// vouch for it — measured, an unhardened call with `// Unlike localGitEnv(), this one is fine`
// under it passed every assertion here (BP-516 review). Every call site today writes
// `env: localGitEnv(` or `env: { ...localGitEnv(`, so anchoring costs nothing.
const HARDENED_ENV = /env:\s*\{?\s*(\.\.\.)?\s*(localGitEnv|operatorGitEnv|hardenedGitConfig)\(/;

function sources(): { file: string; source: string }[] {
  const dir = join(import.meta.dirname, ".");
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
    .map((file) => ({ file, source: readFileSync(join(dir, file), "utf8") }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

describe("every git invocation is hardened", () => {
  it("still finds every file that spawns git", () => {
    const found = sources()
      .filter(({ source }) => [...source.matchAll(RUNS_GIT)].length > 0)
      .map(({ file }) => file);

    expect(found).toEqual(FILES_THAT_RUN_GIT);
  });

  it("builds the environment of every git call from the shared helpers", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources()) {
      // delivery.ts composes one environment in a helper of its own and every call it makes goes
      // through it — it is the only path carrying GH_TOKEN, and hardenedGitConfig is what that
      // helper builds. Exempted by name rather than by a window that would have to reach it.
      if (MAY_COMPOSE_A_GIT_ENVIRONMENT.includes(file)) continue;

      const sites = [...source.matchAll(RUNS_GIT)];
      sites.forEach((match, nth) => {
        // Up to the NEXT call site, never past it: a window measured in characters made one call's
        // environment vouch for the one above it, and in commit.ts the two are 535 characters
        // apart. Measured — an unhardened call inserted above a hardened one passed.
        const ends = sites[nth + 1]?.index ?? match.index + 800;
        const window = source.slice(match.index, ends);
        if (HARDENED_ENV.test(window)) return;
        offenders.push(`${file}: the git call at ${match.index} builds its own environment`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the environment that still reads the operator's config to the one call that needs it", () => {
    const readers = sources()
      .filter(({ file, source }) => file !== "git-safety.ts" && /operatorGitEnv\(/.test(source))
      .map(({ file }) => file);

    expect(readers).toEqual(MAY_READ_THE_OPERATORS_CONFIG);
  });

  // Per call, not per file: commit.ts holds two git calls, and pinning the file alone let the
  // staging call take the identity read's exemption — putting `~/.gitconfig` back in front of the
  // thing BP-403 guards, with every other assertion here still green (BP-516 review).
  it("lets only the identity read use it, not every call in that file", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources()) {
      if (file === "git-safety.ts") continue;
      const sites = [...source.matchAll(RUNS_GIT)];
      sites.forEach((match, nth) => {
        const window = source.slice(match.index, sites[nth + 1]?.index ?? match.index + 800);
        if (!/operatorGitEnv\(/.test(window)) return;
        // Two calls, one question: who git would commit as, and whether anybody chose the address
        // rather than git guessing it from the hostname. Both read the operator's own config
        // because that is where the answer is; nothing else may.
        if (/GIT_AUTHOR_IDENT|"user\.email"/.test(window)) return;
        offenders.push(`${file}: the git call at ${match.index} reads the operator's own config`);
      });
    }

    expect(offenders).toEqual([]);
  });

  // The variables are the helpers' to set, matched as an assignment so a paragraph explaining what
  // they do is not read as a call site deciding for itself.
  it("leaves the config variables to the helpers", () => {
    const offenders = sources()
      .filter(
        ({ file, source }) =>
          !MAY_COMPOSE_A_GIT_ENVIRONMENT.includes(file) &&
          // The quotes are not optional decoration: `"GIT_CONFIG_GLOBAL": "…"` is a key an object
          // literal can carry past a rule that expects the name to touch its colon, and the spread
          // that carries it wins over the helper it spreads (BP-516 review).
          /GIT_CONFIG_(NOSYSTEM|GLOBAL)["']?\s*[:=]/.test(source),
      )
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("never passes -c core.* inline instead of gitArgs", () => {
    const offenders = sources()
      .filter(({ file, source }) => !file.includes("git-safety") && /["']-c["']\s*,\s*["']core\./.test(source))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });
});

describe("localGitEnv", () => {
  it("puts the operator's global config outside the call", () => {
    expect(localGitEnv().GIT_CONFIG_GLOBAL).toBe(NO_GLOBAL_CONFIG);
    expect(localGitEnv().GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  // The commit identity rides here, because `~/.gitconfig` no longer answers for it
  it("lets the caller add variables of its own", () => {
    expect(localGitEnv([], { GIT_AUTHOR_EMAIL: "a@b" }).GIT_AUTHOR_EMAIL).toBe("a@b");
  });

  // And cannot let it reach past them. A caller's env used to be spread last, which put the whole
  // hardening at the mercy of any call site that passed one — and the tripwire above cannot see a
  // key that arrives inside an object (BP-516 review).
  it("does not let a caller's own variables turn the hardening off", () => {
    const env = localGitEnv([], {
      GIT_CONFIG_GLOBAL: "/Users/someone/.gitconfig",
      GIT_CONFIG_NOSYSTEM: "0",
    });

    expect(env.GIT_CONFIG_GLOBAL).toBe(NO_GLOBAL_CONFIG);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  // The one environment that must NOT neutralise it: the identity is the operator's to keep there
  it("leaves the global config readable where the identity is read", () => {
    expect(operatorGitEnv().GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(operatorGitEnv().GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  // The same discipline, asserted the same way: it grew an `extra` parameter for the neutral
  // GIT_DIR, and a parameter that can reach the hardening is the hole the one above closed.
  it("does not let that caller's variables turn the rest of the hardening off either", () => {
    expect(operatorGitEnv({ GIT_CONFIG_NOSYSTEM: "0" }).GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(operatorGitEnv({ GIT_DIR: "/tmp/nothing" }).GIT_DIR).toBe("/tmp/nothing");
  });
});
