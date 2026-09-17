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
 * Read from the source with its comments stripped. The previous version of this test read them,
 * and a paragraph explaining what `GIT_CONFIG_NOSYSTEM` does was enough to fail a file that had
 * stopped naming it in code at all — a scanner that reads prose as readily as code reports both,
 * and the one it is for is the code.
 */
const MAY_COMPOSE_A_GIT_ENVIRONMENT = ["delivery.ts", "git-safety.ts"];

// commitAll's identity read is the one call that still reads the operator's own config, and there
// is nothing else it could be for: a second user would mean a git call the scan cannot vouch for.
const MAY_READ_THE_OPERATORS_CONFIG = ["commit.ts"];

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function sources(): { file: string; source: string }[] {
  const dir = join(import.meta.dirname, ".");
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
    .map((file) => ({ file, source: code(readFileSync(join(dir, file), "utf8")) }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

describe("every git invocation is hardened", () => {
  it("builds the environment of every git call from the shared helpers", () => {
    const offenders: string[] = [];

    for (const { file, source } of sources()) {
      // delivery.ts composes one environment in a helper of its own and every call it makes goes
      // through it — it is the only path carrying GH_TOKEN, and hardenedGitConfig is what that
      // helper builds. Exempted by name rather than by a window that would have to reach it.
      if (MAY_COMPOSE_A_GIT_ENVIRONMENT.includes(file)) continue;
      // The window is the options object that follows the command, which is where the env is
      for (const match of source.matchAll(/run\(\s*"git"/g)) {
        const window = source.slice(match.index, match.index + 600);
        if (/localGitEnv\(|operatorGitEnv\(|hardenedGitConfig\(/.test(window)) continue;
        offenders.push(`${file}: a git call builds its own environment`);
      }
    }

    expect(offenders).toEqual([]);
  });

  // The variables are the helpers' to set. A call site that names one is a call site deciding for
  // itself what git reads, which is how the commit and the diff ended up reading ~/.gitconfig for
  // as long as they did (BP-516).
  it("leaves GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL to the helpers", () => {
    const offenders = sources()
      .filter(({ file, source }) =>
        !MAY_COMPOSE_A_GIT_ENVIRONMENT.includes(file) &&
        /GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL/.test(source)
      )
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("keeps the environment that still reads the operator's config to the one call that needs it", () => {
    const readers = sources()
      .filter(({ file, source }) => file !== "git-safety.ts" && /operatorGitEnv\(/.test(source))
      .map(({ file }) => file);

    expect(readers).toEqual(MAY_READ_THE_OPERATORS_CONFIG);
  });

  it("never passes -c core.* inline instead of gitArgs", () => {
    const offenders = sources()
      .filter(({ file, source }) => !file.includes("git-safety") && /["\']-c["\']\s*,\s*["\']core\./.test(source))
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

  // The one environment that must NOT neutralise it: `user.email` is the operator's to keep there
  it("leaves the global config readable where the identity is read", () => {
    expect(operatorGitEnv().GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(operatorGitEnv().GIT_CONFIG_NOSYSTEM).toBe("1");
  });
});
