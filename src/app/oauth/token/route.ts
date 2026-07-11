import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { OAuthCode } from "@/models/oauthCode";
import { OAuthToken } from "@/models/oauthToken";
import {
  randomToken,
  sha256,
  verifyPkceS256,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function tokenError(error: string, description: string, status = 400) {
  return NextResponse.json({ error, error_description: description }, { status, headers: CORS });
}

async function issueTokens(clientId: string, userId: Types.ObjectId, scope: string) {
  const accessToken = randomToken("cpat_");
  const refreshToken = randomToken("cprt_");
  const now = Date.now();

  await OAuthToken.create({
    accessTokenHash: sha256(accessToken),
    refreshTokenHash: sha256(refreshToken),
    clientId,
    user: userId,
    scope,
    accessExpiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
    refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
  });

  return NextResponse.json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope,
    },
    { headers: CORS }
  );
}

export async function POST(req: Request) {
  await connectDB();
  const form = await req.formData();
  const grantType = String(form.get("grant_type") || "");

  if (grantType === "authorization_code") {
    const code = String(form.get("code") || "");
    const redirectUri = String(form.get("redirect_uri") || "");
    const clientId = String(form.get("client_id") || "");
    const codeVerifier = String(form.get("code_verifier") || "");

    if (!code || !codeVerifier) {
      return tokenError("invalid_request", "code and code_verifier are required");
    }

    const rec = await OAuthCode.findOne({ codeHash: sha256(code) });
    if (!rec || rec.used || rec.expiresAt.getTime() < Date.now()) {
      return tokenError("invalid_grant", "authorization code is invalid or expired");
    }
    if (clientId && rec.clientId !== clientId) {
      return tokenError("invalid_grant", "client_id mismatch");
    }
    if (rec.redirectUri !== redirectUri) {
      return tokenError("invalid_grant", "redirect_uri mismatch");
    }
    if (!verifyPkceS256(codeVerifier, rec.codeChallenge)) {
      return tokenError("invalid_grant", "PKCE verification failed");
    }

    rec.used = true;
    await rec.save();

    return issueTokens(rec.clientId, rec.user as Types.ObjectId, rec.scope);
  }

  if (grantType === "refresh_token") {
    const refreshToken = String(form.get("refresh_token") || "");
    const clientId = String(form.get("client_id") || "");

    if (!refreshToken) {
      return tokenError("invalid_request", "refresh_token is required");
    }

    const rec = await OAuthToken.findOne({ refreshTokenHash: sha256(refreshToken) });
    if (!rec || rec.refreshExpiresAt.getTime() < Date.now()) {
      return tokenError("invalid_grant", "refresh token is invalid or expired");
    }
    if (clientId && rec.clientId !== clientId) {
      return tokenError("invalid_grant", "client_id mismatch");
    }

    // Rotate: revoke the old token, issue a fresh pair.
    await OAuthToken.deleteOne({ _id: rec._id });

    return issueTokens(rec.clientId, rec.user as Types.ObjectId, rec.scope);
  }

  return tokenError("unsupported_grant_type", `grant_type '${grantType}' is not supported`);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
