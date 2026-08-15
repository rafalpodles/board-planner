import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryGitArgs, gitArgs, GIT_SAFE_ENV } from "./git-safety.js";

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

  it("refuses the system config", () => {
    expect(GIT_SAFE_ENV.GIT_CONFIG_NOSYSTEM).toBe("1");
  });
});

describe("deliveryGitArgs", () => {
  it("disables the hook path too", () => {
    expect(deliveryGitArgs(["push"])).toContain("core.hooksPath=/dev/null");
  });

  // gh auth setup-git puts its helper in the operator's global config, and delivery is the one call
  // that has to reach the remote; clearing it would break every HTTPS push
  it("leaves the credential helper alone", () => {
    expect(deliveryGitArgs(["push"]).join(" ")).not.toContain("credential.helper");
  });
});

// The same shape as child-env.contract.test.ts. Keyed on the env rather than on the literal "git",
// because delivery.ts passes the command as a variable and is the one call carrying GH_TOKEN.
describe("every git invocation is hardened", () => {
  it("names the shared helper wherever it names GIT_CONFIG_NOSYSTEM", () => {
    const dir = join(import.meta.dirname, ".");
    const offenders: string[] = [];

    for (const file of readdirSync(dir, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts") || file.includes(".test.") || file.includes("git-safety")) continue;
      const source = readFileSync(join(dir, file), "utf8");
      if (source.includes("GIT_CONFIG_NOSYSTEM") && !source.includes("GIT_SAFE_ENV")) {
        offenders.push(`${file}: spells GIT_CONFIG_NOSYSTEM out by hand`);
      }
      if (/["']-c["']\s*,\s*["']core\./.test(source)) {
        offenders.push(`${file}: passes -c core.* inline instead of gitArgs`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
