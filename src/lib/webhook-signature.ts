import crypto from "crypto";

/**
 * Deliveries were unsigned and carried no timestamp, so a receiver had no way to tell one from
 * anybody else who learned the URL, and a captured delivery could be replayed forever (BP-306).
 *
 * Signed over `${timestamp}.${body}`, not the body alone: without the timestamp inside the MAC,
 * the header can be rewritten and the replay window is decoration.
 */
export const SIGNATURE_HEADER = "x-boardplanner-signature";
export const TIMESTAMP_HEADER = "x-boardplanner-timestamp";

function secret(): string {
  return process.env.WEBHOOK_SIGNING_SECRET?.trim() ?? "";
}

export function isWebhookSigningConfigured(): boolean {
  return secret().length > 0;
}

export function signWebhook(body: string, timestamp: string): string | null {
  const key = secret();
  if (!key) return null;
  const mac = crypto.createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function signatureHeaders(body: string, now = Date.now()): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000));
  const signature = signWebhook(body, timestamp);
  // Unsigned rather than undelivered when no secret is set: an instance that never configured one
  // has receivers that do not check, and silently dropping their deliveries would be the worse bug
  if (!signature) return {};
  return { [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: timestamp };
}
