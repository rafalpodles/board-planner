import { hostNotFound } from "@/lib/middleware";
import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { connectDB } from "@/lib/db";
import { scopedForRequest } from "@/lib/db-scope";
import { isValidRedirectUri, newClientId } from "@/lib/oauth";
import { getClientIp } from "@/lib/auth";
import { makeRoomForClient, unusedClientExpiry } from "@/lib/oauth-clients";
import { sourceRefused } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_CLIENT_NAME = 80;
const MAX_REDIRECT_URIS = 10;
const REGISTRATIONS_PER_WINDOW = 10;

// No provenance check: RFC 7591 registration is meant to be called cross-origin and by non-browser
// clients, which send neither Sec-Fetch-Site nor a matching Origin. Refusing them breaks MCP
// onboarding, and the guard buys nothing — the endpoint is unauthenticated, takes no cookie, and
// answers Access-Control-Allow-Origin: *, so a forged call gains what curl already would.
export async function POST(req: Request) {
  const db = await scopedForRequest(req);
  if (!db) return hostNotFound();
  await connectDB();

  // Unauthenticated and public by design. With an address the caller is held to a budget. With none
  // (TRUSTED_PROXY_HOPS unset) a bucket shared by every caller would let one of them close MCP
  // onboarding for the whole instance, so what is bounded is the rows nobody has approved (BP-1030).
  if (await sourceRefused(getClientIp(req), "oauth_register", REGISTRATIONS_PER_WINDOW)) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "Too many client registrations from this address. Try again later." },
      { status: 429, headers: CORS }
    );
  }

  const read = await readJsonBody<Record<string, unknown> | null>(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const redirectUris = body?.redirect_uris;

  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECT_URIS ||
    !redirectUris.every(isValidRedirectUri)
  ) {
    return NextResponse.json(
      {
        error: "invalid_redirect_uri",
        error_description:
          "redirect_uris must be a non-empty array of https URIs; http is accepted only for loopback addresses",
      },
      { status: 400, headers: CORS }
    );
  }

  const clientId = newClientId();
  const clientName =
    typeof body?.client_name === "string" ? body.client_name.slice(0, MAX_CLIENT_NAME) : "";

  if (!(await makeRoomForClient(db))) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "Too many client registrations are waiting to be approved. Try again in a few minutes." },
      { status: 429, headers: CORS }
    );
  }
  await db.OAuthClient.create({ clientId, clientName, redirectUris, expiresAt: unusedClientExpiry() });

  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201, headers: CORS }
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
