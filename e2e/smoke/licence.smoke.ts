/**
 * BP-979: the real licence service and the product, together. Each side's own suite stubs the other (the service's
 * stubs the product, this repo's stubs the service), so the signatures and answers the two exchange were never run
 * against each other. Here the service is a child process started from a checkout (LICENCE_SERVICE_DIR) with the keys
 * this suite already owns; only Stripe is a stand-in, the service's own (e2e/stripe-stub.mjs there).
 *
 * The flow: the daily pull gives a trial; Upgrade starts a checkout through the service; Stripe's signed webhooks make
 * the organisation Pro and the key reaches the product by the service's signed push; a change in people reaches the
 * subscription as a member quantity; Manage subscription opens the portal.
 *
 * Needs E2E_ORGANISATIONS_SERVER=1 and a checkout of the service with its dependencies installed.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { LICENCE_STUB_PORT, ORGANISATIONS_PLATFORM_ORIGIN, RUN_ORGANISATIONS_SERVER } from "../../playwright.config";
import { E2E_LICENCE_PULL_KEY, E2E_LICENCE_SIGNING_KEY, E2E_PLATFORM_REQUEST_KEY } from "../licence-key";
import { ACME, GLOBEX, ORGANISATIONS_API, asOrganisation, bearer, originOf, seedTwoOrganisations, signInOn } from "../organisations";
import { E2E_MONGODB_URI } from "../seed";

const SERVICE_DIR = resolve(process.env.LICENCE_SERVICE_DIR ?? join(__dirname, "..", "..", "..", "board-planner-licence"));
const SERVICE_INSTALLED = existsSync(join(SERVICE_DIR, "node_modules", ".bin", "next"));
// Skipped on a laptop that has not set this up, but never in CI: a job that was meant to run this and skips it is a pass nobody earned
test.skip(!RUN_ORGANISATIONS_SERVER && !process.env.CI, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");
test.skip(!SERVICE_INSTALLED && !process.env.CI, `LICENCE_SERVICE_DIR (${SERVICE_DIR}) is not a licence service checkout with its dependencies installed`);
test.describe.configure({ mode: "serial", timeout: 5 * 60_000 });

const SERVICE_PORT = LICENCE_STUB_PORT;
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;
const STRIPE_PORT = Number(process.env.E2E_STRIPE_STUB_PORT ?? LICENCE_STUB_PORT + 1);
const STRIPE_URL = `http://127.0.0.1:${STRIPE_PORT}`;
const STRIPE_SECRET = "sk_test_smokeNotARealKey";
const WEBHOOK_SECRET = "whsec_smoke_not_a_real_secret";
const PRICES = {
  standard: { month: { base: "price_std_month", member: "price_std_month_member" }, year: { base: "price_std_year", member: "price_std_year_member" } },
  launch: { month: { base: "price_launch_month", member: "price_launch_month_member" }, year: { base: "price_launch_year", member: "price_launch_year_member" } },
};
const ARTIFACTS = resolve(__dirname, "..", ".artifacts", "licence-smoke");
const SERVICE_DATABASE = E2E_MONGODB_URI.replace(/\/[^/?]+(\?|$)/, "/bpl_smoke$1");
const DAY = 86_400;

interface Started {
  child: ChildProcess;
  exited: Promise<void>;
  hasExited: () => boolean;
}
const children: Started[] = [];

const portIsFree = (port: number) =>
  new Promise<boolean>((resolvePort) => {
    const probe = createServer();
    probe.once("error", () => resolvePort(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolvePort(true)));
  });

function start(name: string, command: string, args: string[], env: Record<string, string>): Started {
  mkdirSync(ARTIFACTS, { recursive: true });
  const log = createWriteStream(join(ARTIFACTS, `${name}.log`));
  // Its own process group, so stopping it stops what `next dev` started
  const child = spawn(command, args, { cwd: SERVICE_DIR, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  let gone = false;
  const exited = new Promise<void>((resolveExit) =>
    child.once("exit", () => {
      gone = true;
      log.end();
      resolveExit();
    })
  );
  const started = { child, exited, hasExited: () => gone };
  children.push(started);
  return started;
}

// A process of an earlier run answering on the port would pass this and leave the new one dead of EADDRINUSE, so the
// one being waited for must also still be alive
async function waitFor(url: string, what: string, started: Started) {
  const until = Date.now() + 150_000;
  for (;;) {
    if (started.hasExited()) throw new Error(`${what} exited before it came up; see ${ARTIFACTS}`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`${what} did not come up at ${url}; see ${ARTIFACTS}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
}

async function stop({ child, exited }: Started) {
  if (!child.pid) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      return;
    }
    const gone = await Promise.race([exited.then(() => true), new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), 10_000))]);
    if (gone) return;
  }
}

test.beforeAll(async () => {
  expect(RUN_ORGANISATIONS_SERVER, "set E2E_ORGANISATIONS_SERVER=1: the smoke drives the server with ORGANISATION_DOMAIN").toBe(true);
  expect(SERVICE_INSTALLED, `LICENCE_SERVICE_DIR (${SERVICE_DIR}) must be a licence service checkout with its dependencies installed`).toBe(true);
  for (const port of [SERVICE_PORT, STRIPE_PORT]) expect(await portIsFree(port), `port ${port} is in use: stop what an earlier run left behind`).toBe(true);

  await mongoose.connect(SERVICE_DATABASE);
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
  await seedTwoOrganisations();

  const stripe = start("stripe-stub", "node", ["e2e/stripe-stub.mjs"], { STRIPE_STUB_PORT: String(STRIPE_PORT), STRIPE_STUB_SECRET: STRIPE_SECRET });
  const service = start("licence-service", "npx", ["next", "dev", "-p", String(SERVICE_PORT)], {
    MONGODB_URI: SERVICE_DATABASE,
    PUBLIC_ORIGIN: SERVICE_URL,
    COOKIE_INSECURE: "1",
    OPERATOR_USERNAME: "operator",
    OPERATOR_PASSWORD_HASH: bcrypt.hashSync("smoke-operator-password", 4),
    LICENCE_SIGNING_KEY: JSON.stringify(E2E_LICENCE_SIGNING_KEY),
    E2E: "1",
    E2E_EXTRA_PUBLIC_KEY: JSON.stringify({ keyId: E2E_LICENCE_SIGNING_KEY.keyId, x: E2E_LICENCE_SIGNING_KEY.x }),
    PRODUCT_REQUEST_KEYS: `${E2E_LICENCE_PULL_KEY.keyId}:${E2E_LICENCE_PULL_KEY.x}`,
    PLATFORM_PUSH_KEY: JSON.stringify(E2E_PLATFORM_REQUEST_KEY),
    PLATFORM_PUSH_ORIGIN: ORGANISATIONS_PLATFORM_ORIGIN,
    TRUSTED_PROXY_HOPS: "1",
    STRIPE_SECRET_KEY: STRIPE_SECRET,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICES: JSON.stringify(PRICES),
    STRIPE_API_ORIGIN: STRIPE_URL,
  });
  await waitFor(`${STRIPE_URL}/health`, "the Stripe stand-in", stripe);
  await waitFor(`${SERVICE_URL}/api/health`, "the licence service", service);
  // Nothing an earlier run asked of it may count towards this one
  await fetch(`${STRIPE_URL}/__stub/reset`);
});

test.afterAll(async () => {
  await Promise.all(children.map(stop));
});

const admin = (who = ACME) => ({ ...asOrganisation(who), ...bearer(who) });
const organisationOf = async (request: APIRequestContext, who = ACME) =>
  (await (await request.get(`${ORGANISATIONS_API}/api/organisation`, { headers: admin(who) })).json()) as { plan: string; trial?: boolean; planEndsAt: string | null; members?: number };
const stripeRequests = async (): Promise<{ method: string; path: string; form: Record<string, string> }[]> => (await fetch(`${STRIPE_URL}/__stub/requests`)).json();

function webhook(type: string, object: unknown) {
  const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, data: { object } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return fetch(`${SERVICE_URL}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${signature}` }, body: payload });
}

async function addPeople(count: number) {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    await mongoose.connection.db!.collection("users").insertMany(
      Array.from({ length: count }, (_, i) => ({
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
  } finally {
    await mongoose.disconnect();
  }
}

test("a trial, a checkout, a payment, the members and the portal, through the real service", async ({ page, request }) => {
  await page.route("https://stripe.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Stripe stand-in</h1>" }));

  // 1. The daily ask: the product signs it, the service answers a trial bound to the organisation, the product accepts the key
  expect((await request.post(`${ORGANISATIONS_API}/api/e2e/licence-pull`, { headers: asOrganisation(ACME), data: {} })).status()).toBe(204);
  expect(await organisationOf(request)).toMatchObject({ plan: "pro", trial: true });
  expect(await organisationOf(request, GLOBEX)).toMatchObject({ plan: "pro", trial: true });

  // 2. Upgrade: the admin chooses a year and is sent to the page Stripe made, through the service
  await signInOn(page.context(), ACME);
  await page.goto(`${originOf(ACME)}/settings/organisation`);
  const panel = page.getByTestId("subscription");
  await expect(panel).toContainText("Subscribe to keep Pro when the trial ends");
  await expect(panel).toContainText("The launch price is open");
  await panel.getByLabel("Yearly").check();
  await page.getByTestId("subscription-checkout").click();
  await expect(page).toHaveURL(/^https:\/\/stripe\.test\/pay\/cs_test_/);
  const session = (await stripeRequests()).find((r) => r.path === "/v1/checkout/sessions")!;
  expect(session.form).toMatchObject({
    mode: "subscription",
    "managed_payments[enabled]": "true",
    client_reference_id: ACME.organisation.toHexString(),
    "line_items[0][price]": PRICES.launch.year.base,
    "metadata[launch]": "1",
  });

  // 3. Stripe says it was paid: its own signed webhooks, to the real service, which signs a push to the real product
  const periodEnd = Math.floor(Date.now() / 1000) + 365 * DAY;
  const item = (price: string, quantity: number) => ({ id: `si_${price}`, object: "subscription_item", price: { id: price, object: "price", recurring: { interval: "year" } }, quantity, current_period_start: periodEnd - 365 * DAY, current_period_end: periodEnd });
  await fetch(`${STRIPE_URL}/__stub/subscription`, {
    method: "POST",
    body: JSON.stringify({
      id: "sub_smoke",
      object: "subscription",
      status: "active",
      customer: "cus_smoke",
      cancel_at_period_end: false,
      cancel_at: null,
      metadata: { organisation: ACME.organisation.toHexString(), launch: "1", member_price: PRICES.launch.year.member },
      items: { object: "list", has_more: false, data: [item(PRICES.launch.year.base, 1)] },
    }),
  });
  expect((await webhook("checkout.session.completed", { mode: "subscription", subscription: "sub_smoke", customer: "cus_smoke", client_reference_id: ACME.organisation.toHexString() })).status).toBe(200);
  expect(
    (await webhook("invoice.paid", { id: "in_smoke", amount_paid: 49000, total: 49000, parent: { subscription_details: { subscription: "sub_smoke" } }, lines: { has_more: false, data: [{ period: { start: periodEnd - 365 * DAY, end: periodEnd } }] } })).status
  ).toBe(200);

  await expect.poll(async () => (await organisationOf(request)).trial, { timeout: 30_000, message: "the key the service pushed makes the organisation Pro, no longer on trial" }).toBeFalsy();
  const paid = await organisationOf(request);
  expect(paid.plan).toBe("pro");
  expect(new Date(paid.planEndsAt!).getTime()).toBeGreaterThan(Date.now() + 300 * DAY * 1000);
  expect((await organisationOf(request, GLOBEX)).trial).toBe(true);

  await page.goto(`${originOf(ACME)}/settings/organisation`);
  const details = page.getByTestId("subscription-details");
  await expect(details).toContainText("Yearly");
  await expect(details).toContainText("Launch price");
  await expect(page.getByTestId("subscription-billed")).toHaveText("None");
  await page.screenshot({ path: join(ARTIFACTS, "subscribed.png"), fullPage: true });

  // 4. People arrive: the product tells the service, which sets the members above ten on Stripe's subscription
  await addPeople(12);
  const sync = await (await request.post(`${ORGANISATIONS_API}/api/e2e/member-sync`, { headers: asOrganisation(ACME), data: {} })).json();
  expect(sync).toMatchObject({ sent: 1, failed: 0 });
  const update = (await stripeRequests()).find((r) => r.method === "POST" && r.path === "/v1/subscriptions/sub_smoke")!;
  expect(update.form).toMatchObject({ "items[0][price]": PRICES.launch.year.member, "items[0][quantity]": "3", proration_behavior: "always_invoice" });
  await page.goto(`${originOf(ACME)}/settings/organisation`);
  await expect(page.getByTestId("subscription-members")).toHaveText("13, 10 included");
  await expect(page.getByTestId("subscription-billed")).toHaveText("3 × $3.00 per year");
  await expect(page.getByTestId("subscription-next-invoice")).toContainText("$54.00");

  // 5. Manage subscription: the portal Stripe made for the customer it knows, returning to this page
  await page.getByTestId("subscription-manage").click();
  await expect(page).toHaveURL(/^https:\/\/stripe\.test\/portal\/bps_test_/);
  const portal = (await stripeRequests()).find((r) => r.path === "/v1/billing_portal/sessions")!;
  expect(portal.form).toEqual({ customer: "cus_smoke", return_url: `${originOf(ACME)}/settings/organisation` });
});
