/**
 * Signs a licence key — the emergency path; the licence service signs with the same code.
 *
 * Usage:
 *   LICENCE_SIGNING_KEY='<line 1 of generate-licence-keypair>' \
 *     npx tsx scripts/sign-licence.ts --customer "Acme Ltd" [--plan pro|free] [--expires 2027-10-02]
 *       [--features ai.pm_agent,integrations.coda]
 *
 * --expires is the last UTC day the key is valid, one year from today by default. --features matters
 * only for --plan free; pro grants every feature. Prints the key, the value LICENCE_KEY takes.
 */

import { parseArgs } from "node:util";
import { parseSigningKey, signLicence } from "../src/lib/licence";
import { FEATURE_KEYS } from "../src/lib/entitlements";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parse() {
  try {
    return parseArgs({
      options: {
        customer: { type: "string" },
        plan: { type: "string", default: "pro" },
        expires: { type: "string" },
        features: { type: "string" },
      },
    }).values;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

const values = parse();

const rawKey = process.env.LICENCE_SIGNING_KEY;
if (!rawKey) fail("LICENCE_SIGNING_KEY is required");
const customer = values.customer?.trim();
if (!customer) fail("--customer is required");
const plan = values.plan;
if (plan !== "pro" && plan !== "free") fail("--plan is pro or free");

const features = values.features ? values.features.split(",").map((f) => f.trim()) : [];
const unknown = features.filter((f) => !(FEATURE_KEYS as readonly string[]).includes(f));
if (unknown.length) fail(`Unknown features: ${unknown.join(", ")}`);

const now = new Date();
const expiresAt = values.expires
  ? new Date(`${values.expires}T23:59:59.999Z`)
  : new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
// The round trip catches a day that does not exist, which Date would roll into the next month
if (values.expires && (Number.isNaN(expiresAt.getTime()) || expiresAt.toISOString().slice(0, 10) !== values.expires)) {
  fail("--expires is a date that exists, YYYY-MM-DD");
}

let signingKey;
try {
  signingKey = parseSigningKey(rawKey);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

try {
  console.log(
    signLicence(
      {
        customer,
        plan,
        features,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
      signingKey
    )
  );
} catch (err) {
  fail(`The signing key could not sign: ${err instanceof Error ? err.message : String(err)}`);
}
