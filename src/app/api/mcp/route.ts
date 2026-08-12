import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getAuthUser } from "@/lib/auth";
import { ProvenanceError, selfOrigin } from "@/lib/session";
import { registerPlannerTools } from "@/lib/mcp/tools";

/**
 * The MCP tools call this instance's own API through it, so the base URL must come from
 * configuration and nothing else.
 *
 * BP-303 replaced `getPublicOrigin(req)` here but left it as a `??` fallback — and since
 * APP_ORIGIN has no default and is optional in production, the fallback was the live path on
 * any deployment that never set it. A token holder sending `X-Forwarded-Host: 10.0.0.7:9200`
 * had the server fetch that address and hand back the body. Fails closed now: a deployment
 * with neither APP_ORIGIN nor NEXT_PUBLIC_APP_URL gets no MCP rather than a header-driven one.
 */
function plannerBaseUrl(): string {
  const base = selfOrigin();
  if (!base) {
    throw new Error(
      "APP_ORIGIN (or NEXT_PUBLIC_APP_URL) must be set for the MCP endpoint: its tools call this instance's own API, and the origin must not come from a request header"
    );
  }
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

const handler = withMcpAuth(baseHandler, verifyToken, { required: true });

export { handler as GET, handler as POST, handler as DELETE };
