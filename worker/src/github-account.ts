import { join } from "path";
import { Runner } from "./exec.js";

// Which GitHub identity this machine pushes as. `gh auth switch` writes global machine state that
// any other terminal on the box can flip mid-run, so a worker that reads the active account is
// answering "who was switched to last", not "who did the operator give this machine". The pin is
// this file's whole reason for existing: it is read per call, and the token is resolved for that
// login by name.

const TIMEOUT_MS = 20_000;

export interface GhAccount {
  login: string;
  active: boolean;
}

export interface UsableAccount {
  login: string;
  pinned: boolean;
  // Whether gh holds a session for it. A pinned login gh has never heard of is the case worth
  // naming: it is a typo or a logged-out account, and it fails every push with GitHub's own 403.
  known: boolean;
}

const LOGGED_IN = /^\s*[^\s]*\s*Logged in to \S+ account (\S+)/;
const ACTIVE = /^\s*-\s*Active account:\s*(true|false)/;

// Parsed rather than asked for as JSON because `gh auth status` has no --json: gh 2.97 answers
// `unknown flag`. The shape below is stable across the versions this has been run on, and an
// output that does not match it yields no accounts rather than a throw — an unparsed status is a
// machine we cannot ask, not a machine that is broken.
export function parseGhAccounts(output: string): GhAccount[] {
  const accounts: GhAccount[] = [];
  for (const line of output.split("\n")) {
    const loggedIn = LOGGED_IN.exec(line);
    if (loggedIn) {
      accounts.push({ login: loggedIn[1], active: false });
      continue;
    }
    const active = ACTIVE.exec(line);
    // Belongs to the account named above it, not to the output as a whole — read the other way
    // round, every account on a two-account machine comes back active.
    if (active && accounts.length) accounts[accounts.length - 1].active = active[1] === "true";
  }
  return accounts;
}

export function usableAccount(accounts: GhAccount[], pinned: string): UsableAccount {
  const login = pinned.trim();
  if (login) {
    return { login, pinned: true, known: accounts.some((a) => a.login === login) };
  }
  const active = accounts.find((a) => a.active) ?? accounts[0];
  return { login: active?.login ?? "", pinned: false, known: !!active };
}

export function ghAccountPath(stateDir: string): string {
  return join(stateDir, "github.json");
}

// A login, not a secret — the token it resolves to is never written here. Unreadable or absent
// means nothing is pinned, which is the behaviour every machine had before this file existed.
export function pinnedAccount(
  read: (path: string) => string | null,
  stateDir: string
): string {
  let raw: string | null;
  try {
    raw = read(ghAccountPath(stateDir));
  } catch {
    return "";
  }
  if (raw === null) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return "";
    const account = (parsed as { account?: unknown }).account;
    return typeof account === "string" ? account.trim() : "";
  } catch {
    return "";
  }
}

export function serialisePinnedAccount(account: string): string {
  return `${JSON.stringify({ account: account.trim() }, null, 2)}\n`;
}

// Empty for an empty pin, deliberately: asking gh for "the token" would hand back the active
// account's, which is the very thing being pinned away from. Empty is how every caller says
// "leave gh to resolve this itself, as it always has".
export async function resolveGhToken(
  runner: Runner,
  ghPath: string,
  account: string,
  env: NodeJS.ProcessEnv,
  cwd = "/"
): Promise<string> {
  const login = account.trim();
  if (!login || !ghPath) return "";

  const result = await runner.run(ghPath, ["auth", "token", "--user", login], {
    cwd,
    timeoutMs: TIMEOUT_MS,
    env,
  });
  if (result.code !== 0) return "";
  return result.stdout.trim();
}
