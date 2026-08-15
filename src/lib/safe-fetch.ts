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

    // Credentials are for the host they were issued to, not for wherever it points next. `origin`
    // carries the scheme, so an https→http downgrade to the same host counts as a different origin
    // and drops them too — the credential would otherwise go out in clear text.
    if (next.origin !== origin) request = { ...request, headers: withoutCredentials(request.headers) };

    const method = (request.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      request = { ...request, method: "GET", body: undefined };
    }

    target = next.toString();
  }

  throw new BlockedDestinationError(`More than ${MAX_REDIRECTS} redirects from ${rawUrl}`);
}

/**
 * What survives a hop to another origin — an allowlist, because the denylist it replaced knew about
 * this app's own two credential headers and not about an integration's. GitLab sends its PAT as
 * `PRIVATE-TOKEN` (`gitlab.ts`), so the rule this function exists to enforce did not hold for the
 * one caller in the repo that authenticates with anything else (BP-317).
 *
 * An allowlist also covers the header a future integration adds, which is the shape of the mistake
 * rather than the instance of it. Everything here describes the *request* rather than the caller:
 * nothing in the list identifies anyone.
 */
const CARRIED_ACROSS_ORIGINS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "user-agent",
]);

function withoutCredentials(headers: HeadersInit | undefined): HeadersInit {
  const kept = new Headers();
  new Headers(headers).forEach((value, name) => {
    if (CARRIED_ACROSS_ORIGINS.has(name.toLowerCase())) kept.append(name, value);
  });
  return kept;
}

/**
 * The upstream body goes to the server log, never into the error the route returns —
 * returning it is what turned a blind SSRF into a read one (BP-303).
 */
export async function logUpstreamFailure(service: string, response: Response): Promise<void> {
  const body = await readBoundedText(response, LOGGED_BODY_BYTES);
  console.error(`${service} API ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
}

const LOGGED_BODY_BYTES = 4096;

/**
 * The 500 characters that reach the log used to be sliced off a string the process had already
 * materialised in full — `await response.text()` then `.slice()`. An integration host answering an
 * error with a multi-gigabyte body could exhaust the container while being politely refused, so
 * nothing in the log looked like an attack (BP-317).
 *
 * Reads a bounded prefix and cancels the rest, so the bound is on what is allocated rather than on
 * what is printed.
 */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } catch {
    // A truncated or broken body is not worth failing the caller's error path over
  } finally {
    await reader.cancel().catch(() => {});
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined.subarray(0, maxBytes));
}
