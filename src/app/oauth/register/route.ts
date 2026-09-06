import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/request-body";
import { connectDB } from "@/lib/db";
import { OAuthClient } from "@/models/oauthClient";
import { isValidRedirectUri, newClientId } from "@/lib/oauth";
import { getClientIp } from "@/lib/auth";
import {
  anonymousMultiplier,
  isRateLimited,
  recordFailedAttempt,
  sourceKey,
} from "@/lib/rate-limit";

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

export async function POST(req: Request) {
  await connectDB();

  const clientIp = getClientIp(req);
  const throttleKey = sourceKey(clientIp ?? "-", "oauth_register");
  const ceiling = anonymousMultiplier(clientIp, REGISTRATIONS_PER_WINDOW);
  if (await isRateLimited(throttleKey, ceiling)) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "Too many client registrations from this address. Try again later." },
      { status: 429, headers: CORS }
    );
  }
  await recordFailedAttempt(throttleKey);

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

  await OAuthClient.create({ clientId, clientName, redirectUris });

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
