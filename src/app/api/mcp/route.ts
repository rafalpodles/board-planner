import { NextResponse } from "next/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getAuthUser } from "@/lib/auth";
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
  { basePath: "/api", disableSse: true }
);

async function verifyToken(req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;

  let user;
  try {
    user = await getAuthUser(req);
  } catch (e) {
    if (e instanceof ProvenanceError) return undefined;
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
      { status: 500 }
    );
  }
  return withMcpAuth(baseHandler, verifyToken, { required: true, resourceUrl: origin })(req);
};

export { handler as GET, handler as POST, handler as DELETE };
