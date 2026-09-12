/**
 * The agent spawn as a stub runner sees it.
 *
 * Since BP-349 both `claude` invocations — the implementer step and the review gate — go through
 * `sandbox-exec`, so the CLI's name and arguments sit inside the call rather than being it. Every
 * stub below the seam used to match on `command === "claude"` and silently stopped matching.
 *
 * Shared rather than repeated: there are five stub runners, and the failure mode of getting this
 * wrong in one of them is a test that no longer reaches the agent and passes anyway.
 */
import { writeFileSync } from "node:fs";
import { SANDBOX_COMMAND } from "../sandbox.js";

export function isAgentSpawn(command: string, args: readonly string[]): boolean {
  return command === "claude" || args.includes("claude");
}

/** What the CLI itself was asked, with any confinement wrapper stripped off the front. */
export function agentArgs(command: string, args: readonly string[]): string[] {
  if (command === "claude") return [...args];
  const start = args.indexOf("claude");
  return start === -1 ? [...args] : args.slice(start + 1);
}

/**
 * Preflight's sandbox probe, which is the other thing spawned through `sandbox-exec` — so a stub
 * that keys on the command alone would answer the agent's spawn with the probe's answer.
 */
export function isSandboxProbe(command: string, args: readonly string[]): boolean {
  return command === SANDBOX_COMMAND && args.includes("/bin/sh");
}

/**
 * A machine whose sandbox works, played by hand: the probe's allowed write lands and its attempt to
 * escape does not. The marker is the positive control `sandboxCheck` insists on — a stub that
 * returned success without it is a machine where nothing ran, which is a failed check now.
 */
export function answerSandboxProbe(args: readonly string[]): void {
  writeFileSync(args[args.length - 1], "ran");
}
