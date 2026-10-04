import { NextResponse } from "next/server";
import { metadataCorsOptionsRequestHandler } from "mcp-handler";
import { ORIGIN_REQUIRED } from "@/lib/session";
import { scopedForRequest } from "@/lib/db-scope";
import { hostNotFound } from "@/lib/middleware";
import { originFor } from "@/lib/tenant-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This document tells an MCP client where to send the user to authorize and where to POST the
// code, so the origin in it must not come from a request header. It carries no Cache-Control, so
// a forged x-forwarded-host stored by any shared cache would hand other clients an attacker's
// authorization and token endpoints (BP-316).
export async function GET(req: Request) {
  const db = await scopedForRequest(req);
  if (!db) return hostNotFound();
  const origin = await originFor(db);
  if (!origin) {
    return NextResponse.json(
      { error: "server_error", error_description: ORIGIN_REQUIRED },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
  return NextResponse.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    },
    { headers: { "Access-Control-Allow-Origin": "*" } }
  );
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
