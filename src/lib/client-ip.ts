export const TRUSTED_PROXY_HOPS_VAR = "TRUSTED_PROXY_HOPS";

export function trustedProxyHops(): number {
  const raw = process.env[TRUSTED_PROXY_HOPS_VAR]?.trim();
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${TRUSTED_PROXY_HOPS_VAR} must be a non-negative integer — it is the number of proxies that append to X-Forwarded-For in front of this app, and 0 means none`
    );
  }
  return Number(raw);
}

trustedProxyHops();

export function getClientIp(request: Request): string | null {
  const hops = trustedProxyHops();
  if (hops === 0) return null;

  const entries = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length < hops) return null;

  const candidate = entries[entries.length - hops];
  if (!isIpAddress(candidate)) return null;
  return candidate.split("%")[0];
}

export function isIpAddress(value: string): boolean {
  if (value.length > 45) return false;
  const withoutZone = value.split("%")[0];
  return IPV4.test(withoutZone) || IPV6.test(withoutZone);
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 =
  /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,7}:|([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:((:[0-9a-f]{1,4}){1,6})|:((:[0-9a-f]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))$/i;
