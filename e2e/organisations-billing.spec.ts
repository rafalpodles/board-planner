import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createPublicKey, verify } from "node:crypto";
import http from "node:http";
import mongoose from "mongoose";
import { LICENCE_STUB_PORT, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { PLATFORM_HEADERS, platformSigningString, signPlatformRequest } from "../src/lib/platform-request";
import { E2E_LICENCE_PULL_KEY, E2E_PLATFORM_REQUEST_KEY, e2eLicence } from "./licence-key";
import { E2E_MONGODB_URI } from "./seed";
import { ACME, ORGANISATIONS_API, PLATFORM_HOST, asOrganisation, bearer, originOf, seedTwoOrganisations, signInOn } from "./organisations";

/**
 * BP-676, the product's half. In the cloud Settings → Organisation shows the subscription, starts a checkout or the
 * portal through the licence service (a stand-in here, which checks the signature as the service does), and follows
 * the plan after the person comes back from paying.
 */
test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");
test.describe.configure({ mode: "serial" });

interface Asked {
  path: string;
  signed: boolean;
  body: Record<string, unknown>;
}

const asked: Asked[] = [];
let stub: http.Server;
let statusAnswer: { code: number; body: unknown };
let urlAnswer: { code: number; body: unknown };

const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: E2E_LICENCE_PULL_KEY.x }, format: "jwk" });

function signedByBoardPlanner(request: http.IncomingMessage, body: Buffer): boolean {
  const header = (name: string) => String(request.headers[name] ?? "");
  if (header(PLATFORM_HEADERS.keyId) !== E2E_LICENCE_PULL_KEY.keyId) return false;
  const signing = platformSigningString(request.method!, header("host"), request.url!, header(PLATFORM_HEADERS.timestamp), header(PLATFORM_HEADERS.nonce), body);
  return verify(null, Buffer.from(signing), publicKey, Buffer.from(header(PLATFORM_HEADERS.signature), "base64url"));
}

const PERIOD_END = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
const running = (over: Record<string, unknown> = {}) => ({
  billing: true,
  launchOpen: false,
  subscription: { status: "active", interval: "year", launch: true, extraMembers: 3, currentPeriodEnd: PERIOD_END, cancelAtPeriodEnd: false, stripeCustomerId: "cus_not_for_the_browser", ...over },
});
const none = { billing: true, launchOpen: true, subscription: null };

test.beforeAll(async () => {
  stub = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const signed = signedByBoardPlanner(request, body);
      const path = request.url!;
      asked.push({ path, signed, body: JSON.parse(body.toString() || "{}") });
      if (!signed) return void response.writeHead(401).end();
      const answer = path === "/api/billing/status" ? statusAnswer : urlAnswer;
      response.writeHead(answer.code, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => stub.listen(LICENCE_STUB_PORT, "127.0.0.1", resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

test.beforeEach(async ({ page }) => {
  await seedTwoOrganisations();
  asked.length = 0;
  statusAnswer = { code: 200, body: none };
  urlAnswer = { code: 200, body: { url: "https://stripe.test/pay/cs_test_1" } };
  await page.route("https://stripe.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Stripe stand-in</h1>" }));
  await signInOn(page.context(), ACME);
});

// People and unexpired invitations beyond the administrator, which is what a checkout bills members above ten for
async function addHeadcount(people: number, invitations: number) {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    const db = mongoose.connection.db!;
    await db.collection("users").insertMany(
      Array.from({ length: people }, (_, i) => ({
        organisation: ACME.organisation,
        username: `crew${i}`,
        fullName: `crew ${i}`,
        email: `crew${i}@acme.example`,
        kind: "human",
        role: "member",
        deactivatedAt: null,
        createdAt: new Date(),
      }))
    );
    await db.collection("invitations").insertMany(
      Array.from({ length: invitations }, (_, i) => ({
        organisation: ACME.organisation,
        email: `invited${i}@acme.example`,
        role: "member",
        boards: [],
        invitedBy: ACME.adminId,
        tokenHash: `hash${i}`,
        expiresAt: new Date(Date.now() + 60_000_000),
        status: "pending",
        deliveredAs: null,
      }))
    );
  } finally {
    await mongoose.disconnect();
  }
}

const open = async (page: Page, query = "") => {
  await page.goto(`${originOf(ACME)}/settings/organisation${query}`);
  await expect(page.getByRole("heading", { name: "Licence" })).toBeVisible();
};

const pushKey = (request: APIRequestContext) => {
  const path = `/api/platform/organisations/${ACME.organisation.toHexString()}/licence`;
  const body = Buffer.from(JSON.stringify({ licenceKey: e2eLicence({ customer: "acme customer", organisation: ACME.organisation.toHexString(), expiresInDays: 20 }) }));
  return request.post(`${ORGANISATIONS_API}${path}`, {
    headers: { host: PLATFORM_HOST, "content-type": "application/json", ...signPlatformRequest({ method: "POST", host: PLATFORM_HOST, path, body }, E2E_PLATFORM_REQUEST_KEY) },
    data: body,
  });
};

test("a Free organisation's admin chooses a period and is sent to Stripe, with what the service needs to price it", async ({ page }) => {
  await addHeadcount(9, 2);
  await open(page);
  const panel = page.getByTestId("subscription");
  await expect(panel).toContainText("Upgrade to Pro");
  await expect(panel).toContainText("The launch price is open");
  await page.screenshot({ path: "e2e/.artifacts/bp676-upgrade.png", fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.getByTestId("subscription-checkout")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "e2e/.artifacts/bp676-upgrade-phone.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  await panel.getByLabel("Yearly").check();
  await page.getByTestId("subscription-checkout").click();

  await expect(page).toHaveURL("https://stripe.test/pay/cs_test_1");
  const checkout = asked.find((a) => a.path === "/api/billing/checkout")!;
  expect(checkout.signed).toBe(true);
  expect(checkout.body).toEqual({
    organisation: ACME.organisation.toHexString(),
    interval: "year",
    members: 12,
    email: "boss@acme.example",
    successUrl: `${originOf(ACME)}/settings/organisation?checkout=success`,
    cancelUrl: `${originOf(ACME)}/settings/organisation?checkout=cancelled`,
  });
});

test("a running subscription is shown with its period, and Manage subscription goes to the portal", async ({ page }) => {
  statusAnswer = { code: 200, body: running() };
  urlAnswer = { code: 200, body: { url: "https://stripe.test/portal/bps_1" } };
  await open(page);

  const details = page.getByTestId("subscription-details");
  await expect(details).toContainText("Yearly");
  await expect(details).toContainText("Launch price");
  await expect(details).toContainText("3 above the 10 included");
  const read = (await (await page.request.get(`${originOf(ACME)}/api/admin/billing`)).json()) as { subscription: Record<string, unknown> };
  expect(Object.keys(read.subscription).sort()).toEqual(["cancelAtPeriodEnd", "currentPeriodEnd", "extraMembers", "interval", "launch", "status"]);
  await expect(page.getByTestId("subscription-checkout")).toHaveCount(0);
  await page.screenshot({ path: "e2e/.artifacts/bp676-subscribed.png", fullPage: true });

  await page.getByTestId("subscription-manage").click();

  await expect(page).toHaveURL("https://stripe.test/portal/bps_1");
  expect(asked.find((a) => a.path === "/api/billing/portal")).toMatchObject({ signed: true, body: { organisation: ACME.organisation.toHexString(), returnUrl: `${originOf(ACME)}/settings/organisation` } });
});

test("a failed payment and a cancellation are said on the page", async ({ page }) => {
  statusAnswer = { code: 200, body: running({ status: "past_due", cancelAtPeriodEnd: true }) };
  await open(page);

  await expect(page.getByTestId("subscription-past-due")).toContainText("Manage subscription");
  await expect(page.getByTestId("subscription-cancelling")).toContainText("ends with the paid period");
});

test("with no payment service the Licence section is what it was, with no Subscription panel", async ({ page }) => {
  statusAnswer = { code: 200, body: { billing: false } };
  await open(page);

  await expect.poll(() => asked.some((a) => a.path === "/api/billing/status")).toBe(true);
  await expect(page.getByTestId("licence-free")).toBeVisible();
  await expect(page.getByTestId("subscription")).toHaveCount(0);
});

test("a payment service that fails says so and leaves the person where they were", async ({ page }) => {
  urlAnswer = { code: 500, body: {} };
  await open(page);

  await page.getByTestId("subscription-checkout").click();

  await expect(page.getByText("Could not reach the payment service. Try again in a moment.")).toBeVisible();
  // A payment service failing is not this instance losing its database (BP-607)
  await expect(page.getByText("having trouble reaching its database")).toHaveCount(0);
  expect(page.url()).toContain("/settings/organisation");
  await expect(page.getByTestId("subscription-checkout")).toBeEnabled();
});

test("a payment service that answers with something that is not a web page sends the person nowhere", async ({ page }) => {
  urlAnswer = { code: 200, body: { url: "javascript:alert(1)" } };
  await open(page);

  await page.getByTestId("subscription-checkout").click();

  await expect(page.getByText("Could not reach the payment service. Try again in a moment.")).toBeVisible();
  expect(page.url()).toContain("/settings/organisation");
});

test("an organisation that already pays is told so, not sent to pay twice", async ({ page }) => {
  urlAnswer = { code: 409, body: { error: "This organisation already has a subscription", reason: "already_subscribed" } };
  await open(page);

  await page.getByTestId("subscription-checkout").click();

  await expect(page.getByText("This organisation already has a subscription")).toBeVisible();
});

test("a token, even an admin's, cannot start a payment, and the service is never asked", async ({ request }) => {
  const headers = { ...asOrganisation(ACME), ...bearer(ACME) };

  expect((await request.post(`${ORGANISATIONS_API}/api/admin/billing/checkout`, { headers, data: { interval: "month" } })).status()).toBe(403);
  expect((await request.post(`${ORGANISATIONS_API}/api/admin/billing/portal`, { headers, data: {} })).status()).toBe(403);

  expect(asked).toHaveLength(0);
});

test("back from paying, the page follows the plan until it is Pro", async ({ page, request }) => {
  await open(page, "?checkout=success");
  await expect(page.getByTestId("subscription-returned")).toContainText("Thank you");
  await expect(page.getByTestId("subscription-checkout")).toBeDisabled();
  expect(page.url()).not.toContain("checkout=success");
  await page.getByTestId("organisation-name-input").fill("Acme, renamed but not yet saved");

  statusAnswer = { code: 200, body: running({ launch: false, extraMembers: 0, interval: "month" }) };
  expect((await pushKey(request)).status()).toBe(200);

  await expect(page.getByTestId("subscription-details")).toContainText("Monthly", { timeout: 30_000 });
  await expect(page.getByTestId("subscription-returned")).toHaveText("Your subscription is active.");
  await expect(page.getByTestId("plan-badge")).toContainText("Pro");
  await expect(page.getByTestId("organisation-name-input")).toHaveValue("Acme, renamed but not yet saved");
  await expect(page.getByTestId("organisation-plan")).toHaveText("Pro");
  await page.screenshot({ path: "e2e/.artifacts/bp676-after-payment.png", fullPage: true });
});
