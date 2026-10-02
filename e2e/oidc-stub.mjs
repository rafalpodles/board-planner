import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { readBody, serve } from "./stub-guard.mjs";

/**
 * A stand-in OpenID Connect provider for BP-828, so sign-in through an identity provider runs end
 * to end with no network: discovery, an authorization endpoint that approves at once, a token
 * endpoint that checks PKCE and the client's secret, and an RS256-signed ID token.
 *
 * `POST /control` scripts who the next person to authorize is:
 * `{ sub, email, email_verified, name }`. It is process-global for the run, so every spec sets
 * it before it signs anybody in. `GET /last-authorize` returns the query of the last
 * authorization request, so a spec can assert what the app asked for.
 */

const LOOPBACK = "127.0.0.1";
const PORT = Number(process.env.OIDC_STUB_PORT ?? 3997);
const ISSUER = `http://${LOOPBACK}:${PORT}`;
const CLIENT_ID = process.env.OIDC_STUB_CLIENT_ID ?? "board-planner-e2e";
const CLIENT_SECRET = process.env.OIDC_STUB_CLIENT_SECRET ?? "e2e-oidc-secret";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "e2e", alg: "RS256", use: "sig" };

const DEFAULT_PERSON = { sub: "stub-subject", email: "sso-user@example.com", email_verified: true, name: "Sso User" };
let nextPerson = DEFAULT_PERSON;
let lastAuthorize = null;
const codes = new Map();

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

const base64url = (buffer) => buffer.toString("base64url");

function clientFrom(req, form) {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const [id, secret] = Buffer.from(header.slice(6), "base64").toString().split(":").map(decodeURIComponent);
    return { id, secret };
  }
  return { id: form.get("client_id"), secret: form.get("client_secret") };
}

serve({
  name: "oidc stub",
  port: PORT,
  host: LOOPBACK,
  handler: async (req, res) => {
    const url = new URL(req.url ?? "/", ISSUER);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }

    if (req.method === "POST" && url.pathname === "/control") {
      const body = JSON.parse((await readBody(req)) || "{}");
      nextPerson = { ...DEFAULT_PERSON, ...body };
      lastAuthorize = null;
      json(res, { ok: true });
      return;
    }

    if (url.pathname === "/last-authorize") {
      json(res, lastAuthorize);
      return;
    }

    if (url.pathname === "/.well-known/openid-configuration") {
      json(res, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        scopes_supported: ["openid", "email", "profile"],
      });
      return;
    }

    if (url.pathname === "/jwks") {
      json(res, { keys: [jwk] });
      return;
    }

    if (url.pathname === "/authorize") {
      lastAuthorize = Object.fromEntries(url.searchParams);
      const redirect = url.searchParams.get("redirect_uri");
      if (url.searchParams.get("client_id") !== CLIENT_ID || !redirect) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("unknown client");
        return;
      }
      const back = new URL(redirect);
      const state = url.searchParams.get("state");
      if (state) back.searchParams.set("state", state);
      if (url.searchParams.get("code_challenge_method") !== "S256") {
        back.searchParams.set("error", "invalid_request");
      } else {
        const code = base64url(randomBytes(24));
        codes.set(code, {
          redirect,
          nonce: url.searchParams.get("nonce"),
          challenge: url.searchParams.get("code_challenge"),
          person: nextPerson,
        });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { Location: back.href }).end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req));
      const client = clientFrom(req, form);
      if (client.id !== CLIENT_ID || client.secret !== CLIENT_SECRET) {
        json(res, { error: "invalid_client" }, 401);
        return;
      }
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = base64url(createHash("sha256").update(verifier).digest());
      if (!grant || grant.redirect !== form.get("redirect_uri") || grant.challenge !== challenge) {
        json(res, { error: "invalid_grant" }, 400);
        return;
      }
      const { sub, ...claims } = grant.person;
      const idToken = await new SignJWT({ ...claims, ...(grant.nonce ? { nonce: grant.nonce } : {}) })
        .setProtectedHeader({ alg: "RS256", kid: "e2e" })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      json(res, { access_token: base64url(randomBytes(16)), token_type: "Bearer", expires_in: 300, id_token: idToken });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  },
});
