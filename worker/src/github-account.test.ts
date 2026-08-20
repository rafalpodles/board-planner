import { describe, expect, it, vi } from "vitest";
import {
  ghAccountPath,
  parseGhAccounts,
  pinnedAccount,
  resolveGhToken,
  usableAccount,
} from "./github-account.js";
import { CommandResult, RunOpts } from "./exec.js";

const TWO_ACCOUNTS = `github.com
  ✓ Logged in to github.com account other-account (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo'

  ✓ Logged in to github.com account rafalpodles (keyring)
  - Active account: false
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'
`;

function runner(result: Partial<CommandResult>, seen: { command?: string; args?: string[] } = {}) {
  return {
    run: vi.fn(async (command: string, args: string[], _opts: RunOpts) => {
      seen.command = command;
      seen.args = args;
      return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
    }),
  };
}

describe("parseGhAccounts", () => {
  it("reads every account and which one is active", () => {
    expect(parseGhAccounts(TWO_ACCOUNTS)).toEqual([
      { login: "other-account", active: true },
      { login: "rafalpodles", active: false },
    ]);
  });

  it("reads a machine with one account", () => {
    const output = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
`;
    expect(parseGhAccounts(output)).toEqual([{ login: "octocat", active: true }]);
  });

  // gh prints the status banner on stderr for some subcommands and stdout for others, and an
  // unauthenticated machine prints neither shape. Nothing to parse is not a parse failure.
  it("reads nothing out of an unauthenticated machine", () => {
    expect(parseGhAccounts("You are not logged into any GitHub hosts.")).toEqual([]);
    expect(parseGhAccounts("")).toEqual([]);
  });

  // The "Active account:" line belongs to the account named above it. Reading it as a property of
  // the whole output would mark every account active on a two-account machine.
  it("attaches each active flag to the account it follows", () => {
    const reversed = `github.com
  ✓ Logged in to github.com account first (keyring)
  - Active account: false

  ✓ Logged in to github.com account second (keyring)
  - Active account: true
`;
    expect(parseGhAccounts(reversed)).toEqual([
      { login: "first", active: false },
      { login: "second", active: true },
    ]);
  });
});

describe("usableAccount", () => {
  const accounts = [
    { login: "other-account", active: true },
    { login: "rafalpodles", active: false },
  ];

  it("uses the pinned account when gh knows it", () => {
    expect(usableAccount(accounts, "rafalpodles")).toEqual({
      login: "rafalpodles",
      pinned: true,
      known: true,
    });
  });

  // With nothing pinned the worker behaves exactly as it did before this existed: whatever gh has
  // active. A machine with one account never sees a difference.
  it("falls back to gh's active account when nothing is pinned", () => {
    expect(usableAccount(accounts, "")).toEqual({
      login: "other-account",
      pinned: false,
      known: true,
    });
  });

  it("reports a pinned account gh no longer knows", () => {
    expect(usableAccount(accounts, "someone-else")).toEqual({
      login: "someone-else",
      pinned: true,
      known: false,
    });
  });

  it("reports nothing usable when gh knows no accounts", () => {
    expect(usableAccount([], "")).toEqual({ login: "", pinned: false, known: false });
  });
});

describe("pinnedAccount", () => {
  it("reads the login out of the state directory", () => {
    const read = () => JSON.stringify({ account: "rafalpodles" });
    expect(pinnedAccount(read, "/state")).toBe("rafalpodles");
  });

  // Both shapes of "not there": the worker's own reader answers null, a plain fs read throws
  it("is empty when the file is absent", () => {
    expect(pinnedAccount(() => null, "/state")).toBe("");
    expect(
      pinnedAccount(() => {
        throw new Error("ENOENT");
      }, "/state")
    ).toBe("");
  });

  // A half-written file must not stop a worker that was running fine without one. The pin is an
  // optimisation of an identity gh already holds, never the only copy of anything.
  it("is empty when the file is unreadable json", () => {
    expect(pinnedAccount(() => "{ not json", "/state")).toBe("");
    expect(pinnedAccount(() => JSON.stringify({ account: 7 }), "/state")).toBe("");
  });

  it("lives beside the identity and the allowlist", () => {
    expect(ghAccountPath("/state")).toBe("/state/github.json");
  });
});

describe("resolveGhToken", () => {
  it("asks gh for the named account's token", async () => {
    const seen: { command?: string; args?: string[] } = {};
    const deps = runner({ stdout: "gho_abc123\n" }, seen);
    await expect(resolveGhToken(deps, "/opt/homebrew/bin/gh", "rafalpodles", {})).resolves.toBe(
      "gho_abc123"
    );
    expect(seen.command).toBe("/opt/homebrew/bin/gh");
    expect(seen.args).toEqual(["auth", "token", "--user", "rafalpodles"]);
  });

  it("resolves nothing for no account, rather than asking for the active one's token", async () => {
    const deps = runner({ stdout: "gho_active\n" });
    await expect(resolveGhToken(deps, "/usr/bin/gh", "", {})).resolves.toBe("");
    expect(deps.run).not.toHaveBeenCalled();
  });

  // The caller decides what an unresolvable pin means — preflight refuses it, delivery falls back
  // to gh's own resolution. Neither wants an exception thrown through it.
  it("resolves nothing when gh refuses", async () => {
    const deps = runner({ code: 1, stderr: "no such user" });
    await expect(resolveGhToken(deps, "/usr/bin/gh", "ghost", {})).resolves.toBe("");
  });
});
