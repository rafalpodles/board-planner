export type ErrorRequest = {
  path: string;
  method: string;
  headers: { [key: string]: string | string[] | undefined };
};

export type ErrorContext = { routePath?: string; routeType?: string };

const CREDENTIAL = /\b(cp|cpat|cprt|cps)_[A-Za-z0-9._-]+/g;

const MAX_MESSAGE = 300;

function header(request: ErrorRequest, name: string): string {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

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
