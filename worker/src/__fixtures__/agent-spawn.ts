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
export function isAgentSpawn(command: string, args: readonly string[]): boolean {
  return command === "claude" || args.includes("claude");
}

/** What the CLI itself was asked, with any confinement wrapper stripped off the front. */
export function agentArgs(command: string, args: readonly string[]): string[] {
  if (command === "claude") return [...args];
  const start = args.indexOf("claude");
  return start === -1 ? [...args] : args.slice(start + 1);
}
