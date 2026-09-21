import crypto from "crypto";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { withProjectOwner } from "@/lib/middleware";
import { Project } from "@/models/project";
import { PmOauthState } from "@/models/pmOauthState";
import { encryptSecret } from "@/lib/encryption";
import { selfOrigin, ORIGIN_REQUIRED } from "@/lib/session";
import {
  discoverOauthConfig,
  registerClient,
  createPkce,
  buildAuthorizationUrl,
  getPmOauthRedirectUri,
} from "@/lib/pm/mcp-oauth";

export const maxDuration = 60;

export const POST = withProjectOwner(async (request, { params, user }) => {
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

  // Outside the try below, and no middleware has a catch-all — so an unconfigured instance answered
  // Next's bodiless 500 here while the three other origin-dependent routes return the message that
  // names the variable (BP-316 review).
  const origin = selfOrigin();
  if (!origin) {
    return NextResponse.json({ error: ORIGIN_REQUIRED }, { status: 500 });
  }
  const redirectUri = getPmOauthRedirectUri();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oauth: any = server.oauth ?? {};

  // The app's public URL changed since registration (e.g. localhost → production): a dynamically
  // registered client is bound to the old callback, so re-register. Gated on
  // `authorizationEndpoint` rather than `clientId` alone: a server whose Connect has never once
  // succeeded has an empty `redirectUri` too, for the ordinary reason that this route has never
  // finished writing one — not because the callback changed since a real connection, which is the
  // only thing this block is about. `authorizationEndpoint` is set only once discovery has
  // actually completed, which "never connected" and "connected, but before redirectUri was even
  // stored" (the legacy case) tell apart the same way every other legacy record does.
  //
  // Only a client this app registered itself is re-registered silently — `clientSource` is unset
  // for every record predating it, including that legacy one, and treated the same as "typed": a
  // client the admin typed by hand is registered with the provider under the OLD callback by the
  // admin, not by us, and silently discarding it (registering a fresh one nobody asked for,
  // without a word) replaced a credential the admin owns with one the provider has never heard of
  // (BP-751).
  if (oauth.clientId && oauth.authorizationEndpoint && oauth.redirectUri !== redirectUri) {
    if (oauth.clientSource === "registered" && oauth.registrationEndpoint) {
      oauth.clientId = "";
      oauth.clientSecret = "";
      oauth.clientSource = "";
      oauth.accessToken = "";
      oauth.refreshToken = "";
      oauth.expiresAt = null;
      oauth.status = "unconfigured";
    } else {
      return NextResponse.json(
        {
          error: `This connection's callback address changed to ${redirectUri}. Register that address with the provider for this client, then update it here — a client id not obtained through dynamic registration here is never replaced automatically.`,
        },
        { status: 400 }
      );
    }
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
      oauth.clientSource = "registered";
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
