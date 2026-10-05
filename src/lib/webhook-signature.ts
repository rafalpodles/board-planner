import crypto from "crypto";
import type { Types } from "mongoose";
import { organisationDomain } from "./organisation-host";

/**
 * Deliveries were unsigned and carried no timestamp, so a receiver had no way to tell one from
 * anybody else who learned the URL, and a captured delivery could be replayed forever (BP-306).
 *
 * Signed over `${timestamp}.${body}`, not the body alone: without the timestamp inside the MAC,
 * the header can be rewritten and the replay window is decoration.
 */
export const SIGNATURE_HEADER = "x-boardplanner-signature";
export const TIMESTAMP_HEADER = "x-boardplanner-timestamp";

function instanceSecret(): string {
  return process.env.WEBHOOK_SIGNING_SECRET?.trim() ?? "";
}

export type SigningProject = { _id: Types.ObjectId | string; webhookSigningVersion?: number | null };

/**
 * With organisations on subdomains each project signs with its own key, derived from the
 * instance's, its organisation, its id and a version its owner bumps to rotate: whoever reads one
 * project's key can verify — and forge — nothing else, and a key handed to somebody who leaves is
 * retired by rotating. Nothing is stored. A single-organisation instance signs with the secret as set.
 */
export function webhookSigningSecret(organisation: Types.ObjectId, project: SigningProject): string {
  const key = instanceSecret();
  if (!key || !organisationDomain()) return key;
  const scope = `webhook-signing:${organisation.toHexString()}:${String(project._id)}:${project.webhookSigningVersion ?? 0}`;
  return crypto.createHmac("sha256", key).update(scope).digest("hex");
}

export function isWebhookSigningConfigured(): boolean {
  return instanceSecret().length > 0;
}

export function signWebhook(body: string, timestamp: string, organisation: Types.ObjectId, project: SigningProject): string | null {
  const key = webhookSigningSecret(organisation, project);
  if (!key) return null;
  const mac = crypto.createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function signatureHeaders(
  body: string,
  organisation: Types.ObjectId,
  project: SigningProject,
  now = Date.now()
): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000));
  const signature = signWebhook(body, timestamp, organisation, project);
  // Unsigned rather than undelivered when no secret is set: an instance that never configured one
  // has receivers that do not check, and silently dropping their deliveries would be the worse bug
  if (!signature) return {};
  return { [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: timestamp };
}
