export interface Acquisition {
  source?: string;
  medium?: string;
  campaign?: string;
  referrerHost?: string;
}

const TAG_MAX = 100;
const TAG = /^[A-Za-z0-9._+\-]+$/;
const HOST_MAX = 253;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function tag(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, TAG_MAX);
  return TAG.test(trimmed) ? trimmed : undefined;
}

function host(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lowered = value.trim().toLowerCase().replace(/\.$/, "");
  if (lowered.length > HOST_MAX) return undefined;
  if (!HOST.test(lowered) || /^\d+$/.test(lowered.slice(lowered.lastIndexOf(".") + 1))) return undefined;
  return lowered;
}

export function readAcquisition(value: unknown): Acquisition | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const read: Acquisition = {
    source: tag(input.source),
    medium: tag(input.medium),
    campaign: tag(input.campaign),
    referrerHost: host(input.referrerHost),
  };
  const kept = Object.fromEntries(Object.entries(read).filter(([, v]) => v !== undefined)) as Acquisition;
  return Object.keys(kept).length > 0 ? kept : null;
}

function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

const isOurs = (candidate: string, ownDomains: string[]) => ownDomains.some((domain) => candidate === domain || candidate.endsWith(`.${domain}`));

export function acquisitionFromLanding(search: string, referrer: string, ownDomains: string[]): Acquisition | null {
  const query = new URLSearchParams(search);
  const referrerHost = host(query.get("ref")) ?? host(hostOfUrl(referrer));
  return readAcquisition({
    source: query.get("utm_source"),
    medium: query.get("utm_medium"),
    campaign: query.get("utm_campaign"),
    referrerHost: referrerHost && !isOurs(referrerHost, ownDomains) ? referrerHost : undefined,
  });
}

export function acquisitionQuery(acquisition: Acquisition | null): string {
  if (!acquisition) return "";
  const query = new URLSearchParams();
  if (acquisition.source) query.set("utm_source", acquisition.source);
  if (acquisition.medium) query.set("utm_medium", acquisition.medium);
  if (acquisition.campaign) query.set("utm_campaign", acquisition.campaign);
  if (acquisition.referrerHost) query.set("ref", acquisition.referrerHost);
  return query.toString();
}
