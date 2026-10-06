import { createPrivateKey, createPublicKey } from "node:crypto";
import { connectDB } from "./db";
import { forEachServedOrganisation } from "./organisation-jobs";
import { organisationDomain } from "./organisation-host";
import { storeOrganisationLicence, type StoreOutcome } from "./organisation-licence";
import { signPlatformRequest } from "./platform-request";
import { Organisation } from "@/models/organisation";

export const LICENCE_PULL_PATH = "/api/organisations/licence";
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_PULL_DELAY_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TIMER_MS = 2_147_483_647;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface LicencePullConfig {
  url: URL;
  key: { keyId: string; d: string; x: string };
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

function keyPairMatches(key: { d: string; x: string }): boolean {
  try {
    const derived = createPublicKey(createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: key.d, x: key.x }, format: "jwk" })).export({ format: "jwk" });
    return derived.x === key.x;
  } catch {
    return false;
  }
}

export function licencePullConfig(env: NodeJS.ProcessEnv = process.env): LicencePullConfig | null {
  const rawUrl = env.LICENCE_SERVICE_URL?.trim();
  const rawKey = env.LICENCE_PULL_KEY?.trim();
  if (!rawUrl && !rawKey) return null;
  if (!rawUrl || !rawKey) throw new Error("LICENCE_SERVICE_URL and LICENCE_PULL_KEY go together: set both, or neither");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("LICENCE_SERVICE_URL must be an origin such as https://licence.board-planner.com");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("LICENCE_SERVICE_URL must be an origin with no path");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("LICENCE_SERVICE_URL must be https (plain http only to a loopback address)");
  }

  let key: unknown;
  try {
    key = JSON.parse(rawKey);
  } catch {
    throw new Error("LICENCE_PULL_KEY must be the JSON {keyId, d, x} of an Ed25519 key");
  }
  const { keyId, d, x } = (key ?? {}) as Record<string, unknown>;
  if (typeof keyId !== "string" || !keyId || typeof d !== "string" || !BASE64URL.test(d) || typeof x !== "string" || !BASE64URL.test(x) || !keyPairMatches({ d, x })) {
    throw new Error("LICENCE_PULL_KEY must be the JSON {keyId, d, x} of an Ed25519 key");
  }
  return { url, key: { keyId, d, x } };
}

export function assertLicencePullConfig(): void {
  licencePullConfig();
}

export type PullOutcome = StoreOutcome | { status: "none" } | { status: "refused"; httpStatus: number } | { status: "unreachable" };

export async function pullLicence(config: LicencePullConfig, organisation: { _id: { toHexString(): string }; name?: string; slug?: string | null }): Promise<PullOutcome> {
  const id = organisation._id.toHexString();
  const body = new TextEncoder().encode(JSON.stringify({ organisation: id, name: organisation.name ?? "", slug: organisation.slug ?? null }));
  const headers = signPlatformRequest({ method: "POST", host: config.url.host, path: LICENCE_PULL_PATH, body }, config.key);

  let response: Response;
  try {
    response = await fetch(new URL(LICENCE_PULL_PATH, config.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    return { status: "unreachable" };
  }
  if (!response.ok) return { status: "refused", httpStatus: response.status };

  const text = await response.text().catch(() => "");
  if (text.length > MAX_RESPONSE_BYTES) return { status: "refused", httpStatus: response.status };
  let answer: { licenceKey?: unknown } | null = null;
  try {
    answer = JSON.parse(text);
  } catch {
    answer = null;
  }
  if (typeof answer?.licenceKey !== "string" || !answer.licenceKey) return { status: "none" };
  return storeOrganisationLicence(id, answer.licenceKey, `pull:${config.key.keyId}`);
}

export async function pullEveryLicence(config: LicencePullConfig): Promise<void> {
  await connectDB();
  await forEachServedOrganisation("Licence pull", async (db) => {
    const row = await Organisation.findById(db.organisation).select("name slug").lean();
    if (!row) return;
    const outcome = await pullLicence(config, row);
    if (outcome.status === "refused" || outcome.status === "unreachable" || outcome.status === "invalid") {
      console.warn(`Licence pull: ${outcome.status}${"httpStatus" in outcome ? ` (${outcome.httpStatus})` : ""}`);
    }
  });
}

export function licencePullTickMs(raw: string | undefined = process.env.LICENCE_PULL_TICK_MS): number {
  const value = raw?.trim();
  if (!value) return DAY_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`LICENCE_PULL_TICK_MS=${JSON.stringify(value)} is not a number of milliseconds; pulling daily`);
    return DAY_MS;
  }
  if (parsed === 0) return 0;
  return Math.min(Math.max(parsed, FIRST_PULL_DELAY_MS), MAX_TIMER_MS);
}

let started = false;

export function startLicencePull(): { started: boolean; reason?: string } {
  if (started) return { started: true };
  if (!organisationDomain()) return { started: false, reason: "organisations are not on subdomains" };
  const config = licencePullConfig();
  if (!config) return { started: false, reason: "LICENCE_SERVICE_URL and LICENCE_PULL_KEY are not set" };
  const tickMs = licencePullTickMs();
  if (tickMs === 0) return { started: false, reason: "LICENCE_PULL_TICK_MS is 0" };

  started = true;
  let pulling = false;
  const pull = () => {
    if (pulling) return;
    pulling = true;
    pullEveryLicence(config)
      .catch((error) => console.error("Licence pull failed:", error))
      .finally(() => {
        pulling = false;
      });
  };
  setTimeout(pull, FIRST_PULL_DELAY_MS).unref();
  setInterval(pull, tickMs).unref();
  return { started: true };
}
