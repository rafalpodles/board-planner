import crypto from "crypto";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withAdmin } from "@/lib/middleware";
import { Project } from "@/models/project";
import { PmOauthState } from "@/models/pmOauthState";
import { encryptSecret } from "@/lib/encryption";
import {
  discoverOauthConfig,
  registerClient,
  createPkce,
  buildAuthorizationUrl,
  getPmOauthRedirectUri,
} from "@/lib/pm/mcp-oauth";

export const maxDuration = 60;

export const POST = withAdmin(async (request, { params, user }) => {
  await connectDB();
  const { projectId } = await params;
  const { name } = await request.json();

  const project = await Project.findById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const server = (project.pm?.mcpServers ?? []).find((s) => s.name === name);
  if (!server) {
    return NextResponse.json({ error: `No MCP server named "${name}" — save the connection first` }, { status: 404 });
  }
  if (server.authType !== "oauth") {
    return NextResponse.json({ error: `Server "${name}" does not use OAuth auth` }, { status: 400 });
  }

  const redirectUri = getPmOauthRedirectUri(request);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oauth: any = server.oauth ?? {};

  // The app's public URL changed since registration (e.g. localhost → production):
  // a dynamically registered client is bound to the old callback, so re-register.
  // Covers legacy registrations too, where oauth.redirectUri was never stored.
  if (oauth.clientId && oauth.registrationEndpoint && oauth.redirectUri !== redirectUri) {
    oauth.clientId = "";
    oauth.clientSecret = "";
    oauth.accessToken = "";
    oauth.refreshToken = "";
    oauth.expiresAt = null;
    oauth.status = "unconfigured";
  }

  try {
    if (!oauth.authorizationEndpoint || !oauth.tokenEndpoint) {
      const cfg = await discoverOauthConfig(server.url);
      oauth.authorizationEndpoint = cfg.authorizationEndpoint;
      oauth.tokenEndpoint = cfg.tokenEndpoint;
      oauth.registrationEndpoint = cfg.registrationEndpoint;
      oauth.scopes = cfg.scopes;
      oauth.tokenAuthMethod = cfg.tokenAuthMethod;
    }

    if (!oauth.clientId) {
      if (!oauth.registrationEndpoint) {
        return NextResponse.json(
          { error: "The authorization server does not support dynamic registration — set the client ID (and secret) manually on the connection and save" },
          { status: 400 }
        );
      }
      const registered = await registerClient(oauth.registrationEndpoint, redirectUri);
      oauth.clientId = registered.clientId;
      oauth.clientSecret = registered.clientSecret ? encryptSecret(registered.clientSecret) : "";
      if (registered.clientSecret) oauth.tokenAuthMethod = "client_secret_basic";
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "OAuth discovery failed" },
      { status: 502 }
    );
  }

  oauth.status = oauth.status === "connected" ? "connected" : "unconfigured";
  oauth.redirectUri = redirectUri;
  server.oauth = oauth;
  project.markModified("pm.mcpServers");
  await project.save();

  const { verifier, challenge } = createPkce();
  const state = crypto.randomBytes(32).toString("base64url");
  await PmOauthState.create({
    state,
    project: projectId,
    serverName: server.name,
    codeVerifier: verifier,
    initiatedBy: user._id,
  });

  const authorizationUrl = buildAuthorizationUrl({
    authorizationEndpoint: oauth.authorizationEndpoint,
    clientId: oauth.clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
    scopes: oauth.scopes ?? [],
    resource: server.url,
  });

  return NextResponse.json({ authorizationUrl });
});
