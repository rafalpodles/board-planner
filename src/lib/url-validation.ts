import { isPrivateAddress, isInternalName } from "./private-address";

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
