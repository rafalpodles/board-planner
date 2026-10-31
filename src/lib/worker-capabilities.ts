/**
 * What a worker says it can do, on every request next to `X-CP-Protocol`. The server decides a claim
 * from the header of the claiming request itself, never from what an earlier heartbeat stored: a
 * worker binary that was downgraded must not keep a capability it no longer has. Self-asserted like
 * the checkouts it reports, so it can only narrow what the machine's owner already reaches.
 */
export const CAPABILITIES_HEADER = "x-cp-capabilities";

/** One run holds a worktree per repository of the project, so a project may list several */
export const MULTI_REPOSITORY = "multi-repository";

/** Runs a project's own gate commands. One without it would run npm and report that as the project's check */
export const GATE_COMMANDS = "gate-commands";

const MAX_CAPABILITIES = 16;
const CAPABILITY = /^[a-z][a-z0-9-]{0,63}$/;

export function capabilitiesOf(request: Request): string[] {
  const header = request.headers.get(CAPABILITIES_HEADER) ?? "";
  const named = header
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => CAPABILITY.test(value));
  return [...new Set(named)].slice(0, MAX_CAPABILITIES);
}
