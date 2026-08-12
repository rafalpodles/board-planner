import { NextResponse } from "next/server";
import { protectedResourceHandler, metadataCorsOptionsRequestHandler } from "mcp-handler";
import { selfOrigin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same reason as the authorization-server document beside it: a header-derived origin here names
// the authorization server an MCP client will trust (BP-316).
export async function GET(req: Request) {
  const origin = selfOrigin();
  if (!origin) {
    return NextResponse.json(
      { error: "server_error", error_description: "APP_ORIGIN is not configured" },
      { status: 500 }
    );
  }
  return protectedResourceHandler({ authServerUrls: [origin] })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
