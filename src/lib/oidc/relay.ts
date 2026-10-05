import type { Types } from "mongoose";

/**
 * `OIDC_RELAY_ORIGIN`: another address of this instance that providers send the browser back to,
 * which forwards the answer to the callback on `selfOrigin()` (per organisation from BP-666). Null when
 * unset; a value that is not a bare https origin (http only to 127.0.0.1/[::1]) throws, and
 * `assertSignInConfig` does so at startup.
 */
export function relayOrigin(): string | null {
  const raw = process.env.OIDC_RELAY_ORIGIN?.trim();
  if (!raw) return null;
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {}
  const loopback = url && ["127.0.0.1", "[::1]"].includes(url.hostname);
  const bare =
    url && url.pathname.replace(/\/+$/, "") === "" && !url.search && !url.hash && !url.username && !url.password;
  if (url && bare && (url.protocol === "https:" || (url.protocol === "http:" && loopback))) return url.origin;
  throw new Error(`OIDC_RELAY_ORIGIN must be a bare https origin (http only on 127.0.0.1 or [::1]), not "${raw}"`);
}

// With organisations on subdomains the relay is on the platform host, which belongs to none: the
// sign-in is found by its state alone — 128 random bits, live and unspent — and sent home to the
// organisation that began it, an address read from the flow and never from the request
export async function relayedHome(provider: string, state: string): Promise<string | null | "expired"> {
  const { organisationDomain, organisationOrigin } = await import("../organisation-host");
  const live = { state, provider, claims: null, expiresAt: { $gt: new Date() } };
  if (!organisationDomain()) {
    const { scopedToDefaultOrganisation } = await import("../db-scope");
    const { selfOrigin } = await import("../session");
    const home = selfOrigin();
    if (!home) return null;
    return (await scopedToDefaultOrganisation().OidcFlow.exists(live)) ? home : "expired";
  }
  const { OidcFlow } = await import("@/models/oidcFlow");
  const { acrossOrganisations } = await import("../organisation-wall");
  const flow = await acrossOrganisations(
    OidcFlow.findOne(live).select("organisation"),
    "the relay is on the platform host and finds a sign-in by its random state alone"
  ).lean<{ organisation?: Types.ObjectId }>();
  if (!flow?.organisation) return "expired";
  return organisationOrigin(flow.organisation);
}
