import { NextResponse } from "next/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getAuthUser } from "@/lib/auth";
import { isDatabaseUnreachable } from "@/lib/db-errors";
import { ProvenanceError, selfOrigin, ORIGIN_REQUIRED } from "@/lib/session";
import { registerPlannerTools } from "@/lib/mcp/tools";

/**
 * The MCP tools call this instance's own API through it, so the base URL must come from
 * configuration and nothing else.
 *
 * BP-303 replaced `getPublicOrigin(req)` here but left it as a `??` fallback — and since
 * APP_ORIGIN has no default and is optional in production, the fallback was the live path on
 * any deployment that never set it. A token holder sending `X-Forwarded-Host: 10.0.0.7:9200`
 * had the server fetch that address and hand back the body. Fails closed now: an unconfigured
 * deployment gets no MCP rather than a header-driven one.
 */
function plannerBaseUrl(): string {
  const base = selfOrigin();
  if (!base) throw new Error(ORIGIN_REQUIRED);
  return base;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const baseHandler = createMcpHandler(
  (server) => {
    registerPlannerTools(server);
  },
  { serverInfo: { name: "boardplanner", version: "1.0.0" } },
  { basePath: "/api", disableSse: true },
);

/**
 * Built per request so it can report an outage back to the handler.
 *
 * withMcpAuth catches everything verifyToken throws and answers `invalid_token`, and a client that
 * reads that discards a working OAuth token and walks the whole flow again for another one that
 * fails identically. It cannot be headed off before delegating, either: for the first seconds after
 * a database goes away mongoose still reports the connection as live, so a pre-flight check passes
 * and the failure arrives here, from the query. So the honest place to notice is where it happens —
 * hence the flag rather than a guard (BP-362 review).
 */
function makeVerifyToken(onUnreachable: () => void) {
  return async function verifyToken(
    req: Request,
    bearerToken?: string,
  ): Promise<AuthInfo | undefined> {
    if (!bearerToken) return undefined;

    let user;
    try {
      user = await getAuthUser(req);
    } catch (e) {
      if (e instanceof ProvenanceError) return undefined;
      if (isDatabaseUnreachable(e)) {
        onUnreachable();
        return undefined;
      }
      throw e;
    }
    if (!user) return undefined;

    return {
      token: bearerToken,
      clientId: user.username,
      scopes: [],
      extra: {
        baseUrl: plannerBaseUrl(),
        username: user.username,
      },
    };
  };
}

/**
 * `resourceUrl` is the pointer in the 401's `WWW-Authenticate: resource_metadata=…`, which is the
 * very first thing a client sees and what it follows to find the two discovery documents. Left to
 * mcp-handler it comes from x-forwarded-host, so the documents this route hardened could be routed
 * around by the hint that points at them (BP-316 review).
 *
 * The unconfigured case answers 500 rather than reaching withMcpAuth, whose catch-all turns any
 * throw from verifyToken into `invalid_token` — indistinguishable from an expired credential, and
 * the one message that would have told the operator what to set never leaves the server log.
 */
const handler = async (req: Request) => {
  const origin = selfOrigin();
  if (!origin) {
    return NextResponse.json(
      { error: "server_error", error_description: ORIGIN_REQUIRED },
      { status: 500 },
    );
  }
  let unreachable = false;
  const response = await withMcpAuth(
    baseHandler,
    makeVerifyToken(() => {
      unreachable = true;
    }),
    { required: true, resourceUrl: origin },
  )(req);

  // Answered after the fact rather than before: the 401 mcp-handler has already composed is the
  // wrong one, and replacing it is the only way to say the credential was never the problem
  if (unreachable) {
    return NextResponse.json(
      {
        error: "temporarily_unavailable",
        error_description:
          "The database is unreachable. The credential was not the problem.",
      },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }

  return response;
};

export { handler as GET, handler as POST, handler as DELETE };
