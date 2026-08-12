import { createMcpHandler, withMcpAuth, getPublicOrigin } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getAuthUser } from "@/lib/auth";
import { ProvenanceError, appOrigins } from "@/lib/session";
import { registerPlannerTools } from "@/lib/mcp/tools";

/**
 * The MCP tools call this instance's own API through it, so it must not come from
 * a request header. `getPublicOrigin` reads client-supplied x-forwarded-host, which
 * turned every token holder into a reader of whatever it named (BP-303).
 */
function plannerBaseUrl(req: Request): string {
  return appOrigins()[0] ?? getPublicOrigin(req);
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
      baseUrl: plannerBaseUrl(req),
      username: user.username,
    },
  };
}

const handler = withMcpAuth(baseHandler, verifyToken, { required: true });

export { handler as GET, handler as POST, handler as DELETE };
