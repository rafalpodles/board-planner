import crypto from "crypto";

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
  if (!signature) return {};
  return { [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: timestamp };
}
