import { NextResponse } from "next/server";
import { protectedResourceHandler, metadataCorsOptionsRequestHandler } from "mcp-handler";
import { ORIGIN_REQUIRED } from "@/lib/session";
import { scopedForRequest } from "@/lib/db-scope";
import { hostNotFound } from "@/lib/middleware";
import { originFor } from "@/lib/organisation-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same reason as the authorization-server document beside it: a header-derived origin here names
// the authorization server an MCP client will trust (BP-316).
//
// `resource` needs saying explicitly as well. Without it mcp-handler derives that field from
// x-forwarded-host and then sets max-age=3600 with no Vary — so unlike its sibling, this document
// asks to be cached, and one forged request through a shared cache hands every client for the next
// hour a resource identifier of the attacker's choosing (BP-316 review).
export async function GET(req: Request) {
  const db = await scopedForRequest(req);
  if (!db) return hostNotFound();
  const origin = await originFor(db);
  if (!origin) {
    // The header its success path carries: these documents exist to be fetched cross-origin, and
    // without it a browser MCP client gets an opaque CORS error instead of the message
    return NextResponse.json(
      { error: "server_error", error_description: ORIGIN_REQUIRED },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
  return protectedResourceHandler({ authServerUrls: [origin], resourceUrl: origin })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
