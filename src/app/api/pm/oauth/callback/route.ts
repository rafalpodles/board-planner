import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Project } from "@/models/project";
import { PmOauthState } from "@/models/pmOauthState";
import { decryptSecret, encryptSecret } from "@/lib/encryption";
import { exchangeCode, getPmOauthRedirectUri } from "@/lib/pm/mcp-oauth";

export const maxDuration = 60;

function settingsRedirect(projectId: string | null, result: string): NextResponse {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
  const target = projectId
    ? `${base}/projects/${projectId}/settings?mcp_oauth=${encodeURIComponent(result)}`
    : `${base}/projects?mcp_oauth=${encodeURIComponent(result)}`;
  return NextResponse.redirect(target);
}

// Unauthenticated by necessity (browser redirect carries no Authorization header);
// authenticated by the single-use, TTL-bound state instead.
export async function GET(request: Request) {
  await connectDB();
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const providerError = url.searchParams.get("error");

  const pending = state ? await PmOauthState.findOneAndDelete({ state }) : null;
  if (!pending) {
    return settingsRedirect(null, "error:invalid_state");
  }
  const projectId = String(pending.project);

  if (providerError) {
    return settingsRedirect(projectId, `error:${providerError.slice(0, 40)}`);
  }
  if (!code) {
    return settingsRedirect(projectId, "error:missing_code");
  }

  const project = await Project.findById(pending.project);
  const server = (project?.pm?.mcpServers ?? []).find((s) => s.name === pending.serverName);
  if (!project || !server || server.authType !== "oauth" || !server.oauth?.tokenEndpoint) {
    return settingsRedirect(projectId, "error:connection_gone");
  }

  try {
    const tokens = await exchangeCode({
      tokenEndpoint: server.oauth.tokenEndpoint,
      clientId: server.oauth.clientId,
      clientSecret: server.oauth.clientSecret ? decryptSecret(server.oauth.clientSecret) : "",
      tokenAuthMethod: server.oauth.tokenAuthMethod || "none",
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: getPmOauthRedirectUri(),
      resource: server.url,
    });
    server.oauth.accessToken = encryptSecret(tokens.accessToken);
    server.oauth.refreshToken = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : "";
    server.oauth.expiresAt = tokens.expiresAt;
    server.oauth.status = "connected";
    project.markModified("pm.mcpServers");
    await project.save();
    return settingsRedirect(projectId, "ok");
  } catch (err) {
    console.error("PM OAuth token exchange failed:", err);
    return settingsRedirect(projectId, "error:token_exchange");
  }
}
