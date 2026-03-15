/**
 * Validates a webhook/notification URL to prevent SSRF attacks.
 * Only allows HTTPS URLs pointing to public IP addresses.
 */
export function isAllowedWebhookUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);

    // Only allow HTTPS
    if (url.protocol !== "https:") return false;

    const hostname = url.hostname.toLowerCase();

    // Block localhost and loopback
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0"
    ) {
      return false;
    }

    // Block private/internal IP ranges
    const parts = hostname.split(".");
    if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
      const [a, b] = parts.map(Number);
      if (a === 10) return false; // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
      if (a === 192 && b === 168) return false; // 192.168.0.0/16
      if (a === 169 && b === 254) return false; // 169.254.0.0/16 (link-local / cloud metadata)
      if (a === 0) return false; // 0.0.0.0/8
    }

    // Block cloud metadata endpoints
    if (hostname === "metadata.google.internal") return false;

    return true;
  } catch {
    return false;
  }
}
