import { licencePullConfig } from "./licence-pull";
import { signPlatformRequest } from "./platform-request";

export type BillingAction = "checkout" | "portal" | "status" | "members";

export type BillingAnswer =
  | { status: "ok"; body: Record<string, unknown> }
  | { status: "off" }
  | { status: "unreachable" }
  | { status: "refused"; httpStatus: number; body: Record<string, unknown> };

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Asks the licence service to start a checkout or the portal, or to say what an organisation pays: signed with the
 * same key as the daily licence ask. "off" is a service that takes no payments, or none configured here.
 */
export async function askBilling(action: BillingAction, payload: Record<string, unknown>): Promise<BillingAnswer> {
  let config;
  try {
    config = licencePullConfig();
  } catch {
    return { status: "off" };
  }
  if (!config) return { status: "off" };

  const path = `/api/billing/${action}`;
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const headers = signPlatformRequest({ method: "POST", host: config.url.host, path, body }, config.key);
  let response: Response;
  try {
    response = await fetch(new URL(path, config.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    return { status: "unreachable" };
  }
  const text = await response.text().catch(() => "");
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return { status: "unreachable" };
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value;
  } catch {
    parsed = {};
  }
  if (parsed.billing === false) return { status: "off" };
  if (response.ok) return { status: "ok", body: parsed };
  if (response.status >= 500) return { status: "unreachable" };
  // 404 and 409 are answers about the organisation; the rest (a signature it refused, a request it could not read) are ours to fix
  if (response.status !== 404 && response.status !== 409) console.warn(`The licence service refused a billing ${action} request: ${response.status}`);
  return { status: "refused", httpStatus: response.status, body: parsed };
}
