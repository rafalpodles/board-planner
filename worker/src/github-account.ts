import { join } from "path";
import { Runner } from "./exec.js";

const TIMEOUT_MS = 20_000;

export interface GhAccount {
  login: string;
  active: boolean;
}

export interface UsableAccount {
  login: string;
  pinned: boolean;
  known: boolean;
}

const LOGGED_IN = /^\s*[^\s]*\s*Logged in to \S+ account (\S+)/;
const ACTIVE = /^\s*-\s*Active account:\s*(true|false)/;

export function parseGhAccounts(output: string): GhAccount[] {
  const accounts: GhAccount[] = [];
  for (const line of output.split("\n")) {
    const loggedIn = LOGGED_IN.exec(line);
    if (loggedIn) {
      accounts.push({ login: loggedIn[1], active: false });
      continue;
    }
    const active = ACTIVE.exec(line);
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
