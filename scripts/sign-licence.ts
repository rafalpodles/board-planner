/**
 * Signs a licence key — the emergency path; the licence service signs with the same code.
 *
 * Usage:
 *   LICENCE_SIGNING_KEY='<line 1 of generate-licence-keypair>' \
 *     npx tsx scripts/sign-licence.ts --customer "Acme Ltd" [--plan pro] [--expires 2027-10-02]
 *
 * --expires defaults to one year from today. Prints the key, the value LICENCE_KEY takes.
 */

import { parseArgs } from "node:util";
import { parseSigningKey, signLicence } from "../src/lib/licence";
import { FEATURE_KEYS } from "../src/lib/entitlements";

const { values } = parseArgs({
  options: {
    customer: { type: "string" },
    plan: { type: "string", default: "pro" },
    expires: { type: "string" },
    features: { type: "string" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

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
if (Number.isNaN(expiresAt.getTime())) fail("--expires is a date, YYYY-MM-DD");

console.log(
  signLicence(
    {
      customer,
      plan,
      features,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    parseSigningKey(rawKey)
  )
);
