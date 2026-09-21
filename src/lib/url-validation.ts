import { isPrivateAddress, isInternalName } from "./private-address";
import type { DestinationOptions } from "./safe-fetch";
import { e2eOnlyMounted } from "./e2e-only";

// Loopback only under the e2e suite, never under `next start`: a webhook address is typed by any
// project owner, which is the shape SSRF protection exists for (BP-408)
export const WEBHOOK_DESTINATION: DestinationOptions = {
  allowLoopback: e2eOnlyMounted(process.env.E2E, process.env.NODE_ENV),
};

export const WEBHOOK_DESTINATION_REFUSED =
  "That webhook address is not allowed: it must be https and reachable on the public internet";

/**
 * Configuration-time shape check for a webhook / notification / MCP URL.
 *
 * Synchronous on purpose: it is called from `validatePmConfig`, which answers a 400.
 * It rejects what can be judged from the string alone and nothing more — a name that
 * resolves inward passes here. The boundary is `assertPublicDestination` in
 * `safe-fetch.ts`, which resolves and re-checks at every redirect hop (BP-303).
 */
export function isAllowedWebhookUrl(
  urlString: string,
  options: DestinationOptions = {}
): boolean {
  try {
    const url = new URL(urlString);
    if (options.allowLoopback && isLoopbackHttpUrl(url)) return true;
    if (url.protocol !== "https:") return false;
    if (isInternalName(url.hostname)) return false;
    return !isPrivateAddress(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHttpUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
}

// Webhook rules, plus localhost outside production (local/self-hosted MCP servers)
export function isAllowedMcpServerUrl(urlString: string): boolean {
  if (process.env.NODE_ENV !== "production") {
    try {
      const url = new URL(urlString);
      const host = url.hostname.toLowerCase();
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        (host === "localhost" || host === "127.0.0.1")
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return isAllowedWebhookUrl(urlString);
}
