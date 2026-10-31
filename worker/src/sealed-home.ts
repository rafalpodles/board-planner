import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { agentEnv } from "./env.js";

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The homes to shut: this account's, and the one this process runs under if that is another. */
export function realHomes(source?: NodeJS.ProcessEnv): string[] {
  const running = (source ? source.HOME : agentEnv().HOME) ?? "";
  return [...new Set([real(userInfo().homedir), ...(running ? [real(running)] : [])])];
}

/**
 * What stays readable under a shut home besides what the caller names: the worker's own PATH. A
 * toolchain's `bin` brings its `lib` and `libexec`, which is where an nvm's npm keeps its code, and no
 * more: `~/.cargo/bin` must not open `~/.cargo/credentials.toml`. Nothing at or above a home, however
 * the PATH got there, because that would open all of it.
 */
export function sealedHomesFor(readable: string[], source?: NodeJS.ProcessEnv): { homes: string[]; readable: string[] } {
  const homes = realHomes(source);
  const path = ((source ? source.PATH : agentEnv().PATH) ?? "").split(delimiter).filter((entry) => isAbsolute(entry)).map(real);
  const beside = path.filter((entry) => basename(entry) === "bin").flatMap((entry) => [join(dirname(entry), "lib"), join(dirname(entry), "libexec")]);
  const opened = [...new Set([...readable, ...path, ...beside])];
  return { homes, readable: opened.filter((entry) => !homes.some((home) => home === entry || home.startsWith(`${entry}/`))) };
}

/** The directory a program really lives in, which a CLI's own files sit beside. */
export const programDirectory = (path: string): string => dirname(real(path));
