export interface Acquisition {
  source?: string;
  medium?: string;
  campaign?: string;
  referrerHost?: string;
}

export const ACQUISITION_STORAGE_KEY = "bp_acquisition";

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
  return HOST.test(lowered) ? lowered : undefined;
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

function isOurs(candidate: string, ownHost: string): boolean {
  const parent = ownHost.split(".").slice(1).join(".");
  const domain = parent.includes(".") ? parent : ownHost;
  return candidate === ownHost || candidate === domain || candidate.endsWith(`.${domain}`);
}

export function acquisitionFromLanding(search: string, referrer: string, ownHost: string): Acquisition | null {
  const query = new URLSearchParams(search);
  const referrerHost = host(query.get("ref")) ?? host(hostOfUrl(referrer));
  return readAcquisition({
    source: query.get("utm_source"),
    medium: query.get("utm_medium"),
    campaign: query.get("utm_campaign"),
    referrerHost: referrerHost && !isOurs(referrerHost, ownHost) ? referrerHost : undefined,
  });
}
