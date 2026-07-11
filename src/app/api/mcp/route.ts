import { createMcpHandler, withMcpAuth, getPublicOrigin } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getAuthUser } from "@/lib/auth";
import { registerPlannerTools } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const baseHandler = createMcpHandler(
  (server) => {
    registerPlannerTools(server);
  },
  { serverInfo: { name: "claudeplanner", version: "1.0.0" } },
  { basePath: "/api", disableSse: true }
);

async function verifyToken(req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;

  const user = await getAuthUser(req);
  if (!user) return undefined;

  return {
    token: bearerToken,
    clientId: user.username,
    scopes: [],
    extra: {
      baseUrl: getPublicOrigin(req),
      username: user.username,
    },
  };
}

const handler = withMcpAuth(baseHandler, verifyToken, { required: true });

export { handler as GET, handler as POST, handler as DELETE };
