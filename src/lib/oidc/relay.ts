/**
 * `OIDC_RELAY_ORIGIN`: the one address providers send the browser back to, which forwards the
 * answer to the origin the sign-in started from. Null when unset; a value that is not a bare https
 * origin (http only to 127.0.0.1/[::1]) throws, and `assertSignInConfig` does so at startup.
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
