import { isPrivateAddress, isInternalName, isIpLiteral, unbracket } from "./private-address";

export class BlockedDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedDestinationError";
  }
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface DestinationOptions {
  /**
   * Mirrors the carve-out `isAllowedMcpServerUrl` already makes for local MCP servers.
   * Callers pass `process.env.NODE_ENV !== "production"`; nothing turns it on by itself.
   */
  allowLoopback?: boolean;
}

export async function assertPublicDestination(
  rawUrl: string,
  options: DestinationOptions = {}
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedDestinationError(`Not a URL: ${rawUrl}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlockedDestinationError(`Refusing ${url.protocol} — only http(s) is fetched`);
  }

  const host = unbracket(url.hostname);
  const loopbackIsFine = options.allowLoopback === true;

  if (isInternalName(host)) {
    if (loopbackIsFine && (host === "localhost" || host.endsWith(".localhost"))) return url;
    throw new BlockedDestinationError(`Refusing internal hostname ${host}`);
  }

  if (isIpLiteral(host)) {
    if (!isPrivateAddress(host)) return url;
    if (loopbackIsFine && (host === "127.0.0.1" || host === "::1")) return url;
    throw new BlockedDestinationError(`Refusing private address ${host}`);
  }

  // A public name is the interesting case: localtest.me resolves to 127.0.0.1 and needs
  // no redirect at all to reach inward
  let resolved: { address: string }[];
  try {
    // Imported here so the module graph does not drag node:dns into a non-node runtime
    const { lookup } = await import("node:dns/promises");
    resolved = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new BlockedDestinationError(`Could not resolve ${host}`);
  }
  if (resolved.length === 0) throw new BlockedDestinationError(`Could not resolve ${host}`);

  const inward = resolved.find((entry) => isPrivateAddress(entry.address));
  if (inward) {
    throw new BlockedDestinationError(`${host} resolves to the private address ${inward.address}`);
  }

  return url;
}

/**
 * `fetch` that re-checks the destination at every hop.
 *
 * Node follows redirects itself, so a guard applied only to the configured URL sees
 * the one address the attacker is happy for it to see. Every caller of an outbound
 * fetch goes through here (BP-303).
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: DestinationOptions = {}
): Promise<Response> {
  let target = (await assertPublicDestination(rawUrl, options)).toString();
  let request: RequestInit = { ...init, redirect: "manual" };
  const origin = new URL(target).origin;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(target, request);
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;

    const next = await assertPublicDestination(new URL(location, target).toString(), options);

    // Credentials are for the host they were issued to, not for wherever it points next
    if (next.origin !== origin) request = { ...request, headers: withoutAuth(request.headers) };

    const method = (request.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      request = { ...request, method: "GET", body: undefined };
    }

    target = next.toString();
  }

  throw new BlockedDestinationError(`More than ${MAX_REDIRECTS} redirects from ${rawUrl}`);
}

function withoutAuth(headers: HeadersInit | undefined): HeadersInit {
  const next = new Headers(headers);
  next.delete("authorization");
  next.delete("cookie");
  return next;
}

/**
 * The upstream body goes to the server log, never into the error the route returns —
 * returning it is what turned a blind SSRF into a read one (BP-303).
 */
export async function logUpstreamFailure(service: string, response: Response): Promise<void> {
  const body = await response.text().catch(() => "");
  console.error(`${service} API ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
}
