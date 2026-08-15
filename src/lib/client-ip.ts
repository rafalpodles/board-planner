/**
 * Who the throttle counts against.
 *
 * `X-Forwarded-For` is a request header. Behind a proxy the rightmost entry is written by that
 * proxy and is trustworthy; with nothing in front of the app it is whatever the caller typed. The
 * app used to read it unconditionally, so on the deployment its own README documents — compose
 * publishing the port directly — every request could name its own bucket, and the login throttle,
 * the device-enrolment throttle and the /oauth/register throttle all counted to one and reset
 * (BP-318).
 *
 * So the operator has to say a proxy is there. `TRUSTED_PROXY_HOPS` is the number of proxies that
 * append to this header between the internet and the app; at 0 the header is not read at all.
 *
 * There is no socket address to fall back to — a Web `Request` in a route handler does not carry
 * one — so an unconfigured deployment gets null and callers take their anonymous path. That path
 * is a shared bucket with a raised threshold, which is a worse throttle than a per-address one and
 * a far better one than none.
 */
export const TRUSTED_PROXY_HOPS_VAR = "TRUSTED_PROXY_HOPS";

export function trustedProxyHops(): number {
  const raw = process.env[TRUSTED_PROXY_HOPS_VAR]?.trim();
  if (!raw) return 0;
  // Decimal digits only. A fumbled value must not silently become "trust the header", and it is
  // not 0-and-carry-on either, because an operator who set it meant to be behind a proxy and should
  // see that it did not take. `Number()` alone would read "0x1" as 1 and "1e2" as 100.
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${TRUSTED_PROXY_HOPS_VAR} must be a non-negative integer — it is the number of proxies that append to X-Forwarded-For in front of this app, and 0 means none`
    );
  }
  return Number(raw);
}

// At boot, so a fumbled value is one startup failure naming the variable rather than a throw on
// whichever request happens to reach a throttle first
trustedProxyHops();

export function getClientIp(request: Request): string | null {
  const hops = trustedProxyHops();
  if (hops === 0) return null;

  const entries = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  // Fewer entries than the operator described means the request did not come through the proxies
  // they configured, so nothing in it is the address they promised. Counting the leftmost entry
  // here would be counting the caller's own choice again.
  if (entries.length < hops) return null;

  const candidate = entries[entries.length - hops];
  if (!isIpAddress(candidate)) return null;
  // Without the zone: it is validated away but was being returned, so up to 40 characters of
  // anything travelled into the throttle key and the session's ip column
  return candidate.split("%")[0];
}

/**
 * Deliberately narrow: this value becomes part of a throttle key and is written to the session row,
 * so a 40 kB header entry must not travel with it. A proxy writes an address; anything else is a
 * sign the header is not what the configuration says it is.
 */
export function isIpAddress(value: string): boolean {
  if (value.length > 45) return false;
  const withoutZone = value.split("%")[0];
  return IPV4.test(withoutZone) || IPV6.test(withoutZone);
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// Covers the compressed forms and the IPv4-mapped tail; a proxy writes a canonical address, so
// this does not need to accept every exotic spelling the RFC permits
const IPV6 =
  /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,7}:|([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:((:[0-9a-f]{1,4}){1,6})|:((:[0-9a-f]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))$/i;
