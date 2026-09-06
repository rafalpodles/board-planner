export const HOST_BOUND_SECRETS = [
  { host: "gitlabHost", token: "gitlabToken", label: "GitLab", fallback: "https://gitlab.com" },
  { host: "codaHost", token: "codaToken", label: "Coda", fallback: "https://coda.io" },
] as const;

export type HostBoundSecret = (typeof HOST_BOUND_SECRETS)[number];

export function sameOrigin(a: unknown, b: unknown): boolean {
  const left = originOf(a);
  return left !== null && left === originOf(b);
}

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
    return trimmed.toLowerCase();
  }
}

export function tokensInvalidatedByHostChange(
  updates: Record<string, unknown>,
  before: Record<string, unknown> | null | undefined
): HostBoundSecret[] {
  return HOST_BOUND_SECRETS.filter((pair) => {
    if (updates[pair.host] === undefined) return false;
    const next = configuredHost(updates[pair.host], pair);
    const stored = configuredHost(before?.[pair.host], pair);
    if (sameEndpoint(next, stored)) return false;
    if (typeof updates[pair.token] === "string" && updates[pair.token]) return false;
    return Boolean(before?.[pair.token]);
  });
}

function configuredHost(value: unknown, pair: HostBoundSecret): unknown {
  return typeof value === "string" && value.trim() ? value : pair.fallback;
}

export function clearsStoredToken(
  nextHost: string,
  storedHost: string,
  typedToken: string,
  fallback: string
): boolean {
  if (typedToken.trim()) return false;
  return !sameEndpoint(nextHost.trim() || fallback, storedHost.trim() || fallback);
}
