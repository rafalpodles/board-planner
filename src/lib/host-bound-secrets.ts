/**
 * An integration token is issued for one host, so it must not survive that host being repointed.
 *
 * The tokens are deliberately unreadable — `sanitizeProjectSecrets` strips them from every
 * response — but the host each one is sent to was an ordinary editable field. Changing it and
 * triggering a sync delivered the cleartext credential to an address of the caller's choosing,
 * which is how a masked secret gets exfiltrated by somebody who could never read it (BP-315).
 *
 * The rule already existed one file over: the MCP OAuth branch of `mergeMcpServerTokens` wipes
 * its tokens when the server URL moves, because "they were issued for a different resource".
 */
export const HOST_BOUND_SECRETS = [
  { host: "gitlabHost", token: "gitlabToken", label: "GitLab", fallback: "https://gitlab.com" },
  { host: "codaHost", token: "codaToken", label: "Coda", fallback: "https://coda.io" },
] as const;

export type HostBoundSecret = (typeof HOST_BOUND_SECRETS)[number];

/** Compares configured hosts by origin, so a trailing slash or a case difference is not a move. */
export function sameOrigin(a: unknown, b: unknown): boolean {
  const left = originOf(a);
  return left !== null && left === originOf(b);
}

/**
 * The same question for an endpoint rather than a host: two MCP servers on one origin are two
 * servers, so the path is part of the identity — but a trailing slash or a retyped case is not a
 * different server, and rejecting a save over one is how an admin loses a token they cannot re-read.
 */
export function sameEndpoint(a: unknown, b: unknown): boolean {
  const left = endpointOf(a);
  return left !== null && left === endpointOf(b);
}

function endpointOf(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
}

function originOf(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch {
    // Not parseable as a URL — compare it as the opaque string it is rather than treating two
    // different unparseable values as equal
    return trimmed.toLowerCase();
  }
}

/**
 * Which stored tokens this update invalidates. A request that supplies a new token alongside the
 * new host is the intended way to move an integration, and keeps its token.
 *
 * Absent is not a move: `before` is read lean, so a document written before the host field existed
 * has no value where the schema default would put one, and the form posts that default on every
 * save. Comparing the two literally made an edit to the doc id look like a repointed host and threw
 * away a working token (BP-315 review).
 */
export function tokensInvalidatedByHostChange(
  updates: Record<string, unknown>,
  before: Record<string, unknown> | null | undefined
): HostBoundSecret[] {
  return HOST_BOUND_SECRETS.filter((pair) => {
    if (updates[pair.host] === undefined) return false;
    const next = configuredHost(updates[pair.host], pair);
    const stored = configuredHost(before?.[pair.host], pair);
    if (sameOrigin(next, stored)) return false;
    if (typeof updates[pair.token] === "string" && updates[pair.token]) return false;
    return Boolean(before?.[pair.token]);
  });
}

function configuredHost(value: unknown, pair: HostBoundSecret): unknown {
  return typeof value === "string" && value.trim() ? value : pair.fallback;
}
