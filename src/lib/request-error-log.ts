/**
 * One line naming the request an uncaught error came out of.
 *
 * BP-444 spent its expensive half here: the incident's only trace was `⨯ TypeError: Content-Type
 * was not one of …` with `at ignore-listed frames` and no path, no method and no hint that a
 * credential was involved — so "which request was that?" had to be answered by guessing. Next's
 * `onRequestError` hook knows all three; nothing was reading it.
 *
 * What it must never print is the credential itself. The token is read only to say which KIND was
 * presented, query parameters appear by name and never by value — `/oauth/authorize` and the
 * callback both carry a live authorization code in theirs — and the error's own message is
 * scrubbed, because a cast error quotes the value it choked on.
 */

export type ErrorRequest = {
  path: string;
  method: string;
  headers: { [key: string]: string | string[] | undefined };
};

export type ErrorContext = { routePath?: string; routeType?: string };

// Every credential this instance issues, by prefix: cp_ (API token), cpat_/cprt_ (OAuth access and
// refresh) and cps_ (session). Kept as one pattern so a message and a header cannot disagree.
const CREDENTIAL = /\b(cp|cpat|cprt|cps)_[A-Za-z0-9._-]+/g;

const MAX_MESSAGE = 300;

function header(request: ErrorRequest, name: string): string {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** Which kind of credential was presented, never which one. */
function credentialKind(request: ErrorRequest): string {
  const authorization = header(request, "authorization");
  if (authorization) {
    const [scheme, token = ""] = authorization.split(" ");
    if (scheme.toLowerCase() !== "bearer") return `${scheme.toLowerCase()} header`;
    const prefix = /^(cpat|cprt|cp|cps)_/.exec(token)?.[1];
    return prefix ? `bearer ${prefix}_` : "bearer of no known kind";
  }
  return header(request, "cookie") ? "cookie" : "none";
}

/** The names, so a malformed request can be told from a well-formed one, and never the values. */
function queryKeys(path: string): string {
  const query = path.slice(path.indexOf("?") + 1);
  if (!path.includes("?") || !query) return "";
  return [...new URLSearchParams(query).keys()].join(",");
}

export function describeRequestError(
  error: unknown,
  request: ErrorRequest,
  context: ErrorContext = {}
): string {
  const name = error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(CREDENTIAL, "$1_***").slice(0, MAX_MESSAGE);

  const parts = [
    `${request.method} ${request.path.split("?")[0]}`,
    context.routePath && context.routePath !== request.path.split("?")[0]
      ? `route=${context.routePath}`
      : "",
    context.routeType ? `type=${context.routeType}` : "",
    `credential=${credentialKind(request)}`,
    `content-type=${header(request, "content-type") || "none"}`,
    queryKeys(request.path) ? `query=${queryKeys(request.path)}` : "",
    `${name}: ${message}`,
  ].filter(Boolean);

  return `Unhandled error — ${parts.join(" ")}`;
}
