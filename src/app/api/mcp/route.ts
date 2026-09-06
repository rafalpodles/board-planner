import { NextResponse } from "next/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getAuthUser } from "@/lib/auth";
import { isDatabaseUnreachable } from "@/lib/db-errors";
import { ProvenanceError, selfOrigin, ORIGIN_REQUIRED } from "@/lib/session";
import { registerPlannerTools } from "@/lib/mcp/tools";

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
