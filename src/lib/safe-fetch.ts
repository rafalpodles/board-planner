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

  let resolved: { address: string }[];
  try {
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

    const method = (request.method ?? "GET").toUpperCase();

    if (next.origin !== origin) {
      if ((response.status === 307 || response.status === 308) && request.body != null) {
        throw new BlockedDestinationError(
          `Refusing to replay a ${response.status} body from ${origin} to ${next.origin}`
        );
      }
      request = { ...request, headers: withoutCredentials(request.headers) };
    }

    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      request = { ...request, method: "GET", body: undefined };
    }

    target = next.toString();
  }

  throw new BlockedDestinationError(`More than ${MAX_REDIRECTS} redirects from ${rawUrl}`);
}

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

export async function logUpstreamFailure(service: string, response: Response): Promise<void> {
  const body = await readBoundedText(response, LOGGED_BODY_BYTES);
  console.error(`${service} API ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
}

const LOGGED_BODY_BYTES = 4096;

export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;

  try {
    reader = response.body?.getReader();
    if (!reader) return "";

    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = maxBytes - total;
      const cut = value.byteLength > room;
      const slice = cut ? value.subarray(0, room) : value;
      total += slice.byteLength;
      text += decoder.decode(slice, { stream: true });
      if (cut) return text;
    }
    text += decoder.decode();
  } catch {
  } finally {
    await reader?.cancel().catch(() => {});
  }

  return text;
}

export async function readBoundedJson<T>(response: Response, maxBytes: number): Promise<T> {
  return JSON.parse(await readBoundedText(response, maxBytes)) as T;
}

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
