import { isPrivateAddress, isInternalName } from "./private-address";

/**
 * Configuration-time shape check for a webhook / notification / MCP URL.
 *
 * Synchronous on purpose: it is called from `validatePmConfig`, which answers a 400.
 * It rejects what can be judged from the string alone and nothing more — a name that
 * resolves inward passes here. The boundary is `assertPublicDestination` in
 * `safe-fetch.ts`, which resolves and re-checks at every redirect hop (BP-303).
 */
export function isAllowedWebhookUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "https:") return false;
    if (isInternalName(url.hostname)) return false;
    return !isPrivateAddress(url.hostname);
  } catch {
    return false;
  }
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
