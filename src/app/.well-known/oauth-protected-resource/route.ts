import { NextResponse } from "next/server";
import { protectedResourceHandler, metadataCorsOptionsRequestHandler } from "mcp-handler";
import { selfOrigin, ORIGIN_REQUIRED } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const origin = selfOrigin();
  if (!origin) {
    return NextResponse.json(
      { error: "server_error", error_description: ORIGIN_REQUIRED },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
  return protectedResourceHandler({ authServerUrls: [origin], resourceUrl: origin })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
