import { test, expect, type Page, type Request } from "@playwright/test";
import { randomBytes } from "crypto";
import mongoose from "mongoose";
import {
  GITHUB_STUB_URL,
  OIDC_STUB_LABEL,
  OIDC_STUB_URL,
  PASSWORDLESS_BASE_URL,
  PASSWORDLESS_RELAY_ORIGIN,
  RUN_PASSWORDLESS_SERVER,
} from "../playwright.config";
import { E2E_MONGODB_URI, MEMBER_ID, MEMBER_USERNAME, seed } from "./seed";

/**
 * BP-851. The passwordless server runs with OIDC_RELAY_ORIGIN on 127.0.0.1 while its own address
 * is localhost, so a provider sends the browser back to the relay, which forwards the answer to
 * the callback on the address the sign-in began from — where the binder cookie is.
 */

const SKIP_REASON =
  "needs the password-sign-in-off app server — set E2E_PASSWORDLESS_SERVER=1 (see playwright.config.ts)";
if (!RUN_PASSWORDLESS_SERVER) console.log(`oidc-relay.spec.ts: skipping — ${SKIP_REASON}`);
test.skip(!RUN_PASSWORDLESS_SERVER, SKIP_REASON);

const at = (path: string) => `${PASSWORDLESS_BASE_URL}${path}`;

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

function freshAddress(label: string) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function script(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.ok, `the stub at ${url} refused its script`).toBe(true);
}

async function lastAuthorize(url: string): Promise<Record<string, string>> {
  return (await fetch(url)).json();
}

/** Every request the browser made on the way, so the hop through the relay can be read back. */
function trail(page: Page) {
  const urls: string[] = [];
  page.on("request", (request: Request) => {
    if (request.isNavigationRequest()) urls.push(request.url());
  });
  return urls;
}

async function whoAmI(page: Page) {
  const res = await page.request.get(at("/api/auth/me"));
  return res.ok() ? (await res.json()).username : null;
}

test.beforeEach(async () => {
  await seed();
});

test.afterEach(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test("an OIDC sign-in returns through the relay and finishes signed in on the instance's own address", async ({
  page,
}) => {
  const email = freshAddress("relayed");
  await (await db()).collection("users").updateOne({ _id: MEMBER_ID }, { $set: { email, emailVerifiedAt: new Date() } });
  await script(`${OIDC_STUB_URL}/control`, { sub: `sub-${randomBytes(4).toString("hex")}`, email, email_verified: true });
  const urls = trail(page);

  await page.goto(at("/login"));
  await page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();

  await expect(page).toHaveURL(at("/projects"));
  expect(await whoAmI(page)).toBe(MEMBER_USERNAME);
  expect((await lastAuthorize(`${OIDC_STUB_URL}/last-authorize`)).redirect_uri).toBe(
    `${PASSWORDLESS_RELAY_ORIGIN}/api/auth/oidc/oidc/relay`
  );
  const relayed = urls.findIndex((u) => u.startsWith(`${PASSWORDLESS_RELAY_ORIGIN}/api/auth/oidc/oidc/relay?`));
  const called = urls.findIndex((u) => u.startsWith(at("/api/auth/oidc/oidc/callback?")));
  expect(relayed, urls.join("\n")).toBeGreaterThan(-1);
  expect(called, urls.join("\n")).toBeGreaterThan(relayed);
});

test("a GitHub sign-in crosses the relay the same way", async ({ page }) => {
  const id = 100000 + Math.floor(Math.random() * 1e9);
  await (await db()).collection("identities").insertOne({
    user: MEMBER_ID,
    provider: "github",
    issuer: GITHUB_STUB_URL,
    subject: String(id),
    email: "",
    lastUsedAt: null,
    linkedAt: new Date(),
  });
  await script(`${GITHUB_STUB_URL}/oauth/control`, {
    id,
    login: "octo",
    name: "Octo Person",
    emails: [{ email: freshAddress("octo"), primary: true, verified: true }],
  });

  await page.goto(at("/login"));
  await page.getByRole("button", { name: "Continue with GitHub" }).click();

  await expect(page).toHaveURL(at("/projects"));
  expect(await whoAmI(page)).toBe(MEMBER_USERNAME);
  expect((await lastAuthorize(`${GITHUB_STUB_URL}/oauth/last-authorize`)).redirect_uri).toBe(
    `${PASSWORDLESS_RELAY_ORIGIN}/api/auth/oidc/github/relay`
  );
});

test("a refusal at the provider is relayed back to the sign-in page", async ({ page }) => {
  await script(`${OIDC_STUB_URL}/control`, { sub: "denied", email: freshAddress("denied"), deny: true });

  await page.goto(at("/login"));
  await page.getByRole("button", { name: `Continue with ${OIDC_STUB_LABEL}` }).click();

  await expect(page).toHaveURL(at("/login?sso=failed"));
  expect(await whoAmI(page)).toBeNull();
});

test("a relay link with no sign-in behind it is a dead end, not a redirect", async ({ page }) => {
  const res = await page.goto(`${PASSWORDLESS_RELAY_ORIGIN}/api/auth/oidc/oidc/relay?code=made-up&state=made-up`);

  expect(res?.status()).toBe(400);
  expect(page.url().startsWith(`${PASSWORDLESS_RELAY_ORIGIN}/`)).toBe(true);
  await expect(page.getByRole("heading", { name: "This sign-in has expired" })).toBeVisible();
});
