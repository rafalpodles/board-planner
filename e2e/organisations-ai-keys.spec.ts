import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { AI_STUB_URL, PM_STUB_URL, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { signPlatformRequest } from "../src/lib/platform-request";
import { encryptSecret } from "../src/lib/encryption";
import { E2E_PLATFORM_REQUEST_KEY, e2eLicence } from "./licence-key";
import { E2E_ENCRYPTION_KEY, E2E_MONGODB_URI } from "./seed";
import {
  ACME,
  GLOBEX,
  ORGANISATIONS_API,
  PLATFORM_HOST,
  SHARED_KEY,
  asOrganisation,
  originOf,
  seedTwoOrganisations,
  signInOn,
  type OrganisationFixture,
} from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

/**
 * BP-652. In the cloud the model keys in the server's environment are the operator's, so they are
 * for the plans that include managed AI. A Free organisation gets an upsell and a 402 instead, and
 * an organisation's own key is used whatever its plan and never leaks to another organisation.
 *
 * ACME is Free and GLOBEX is Pro. Which key a call was made with is read off the model stubs.
 */

const OPERATORS_KEY = "Bearer e2e-stub-key";
const OWN_OPENROUTER = "sk-or-acme-e2e-0123456789";
const OWN_OPENAI = "sk-acme-e2e-9876543210";

async function lastAuthorization(stub: string): Promise<string | null> {
  return (await (await fetch(`${stub}/last-authorization`)).json()).authorization;
}

async function makePro(request: APIRequestContext, who: OrganisationFixture) {
  const path = `/api/platform/organisations/${who.organisation.toHexString()}/licence`;
  const body = Buffer.from(
    JSON.stringify({ licenceKey: e2eLicence({ customer: `${who.slug} customer`, organisation: who.organisation.toHexString() }) })
  );
  const headers = signPlatformRequest({ method: "POST", host: PLATFORM_HOST, path, body }, E2E_PLATFORM_REQUEST_KEY);
  const response = await request.post(`${ORGANISATIONS_API}${path}`, {
    headers: { host: PLATFORM_HOST, "content-type": "application/json", ...headers },
    data: body,
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function openNewTaskForm(page: Page, who: OrganisationFixture) {
  await signInOn(page.context(), who);
  await page.goto(`${originOf(who)}/projects/${SHARED_KEY}`);
  await page.getByRole("button", { name: "New task" }).click();
  const modal = page.getByRole("dialog", { name: "New Task" });
  await expect(modal).toBeVisible();
  return modal;
}

const SCRIPTED = `a task <<${JSON.stringify({ title: "From the stub", description: "d", category: "bug", acceptanceCriteria: "" })}>>`;

async function generate(page: Page, modal: ReturnType<Page["getByRole"]>) {
  const generated = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/ai/generate-task"));
  await modal.getByPlaceholder("Describe what you need").fill(SCRIPTED);
  await modal.getByRole("button", { name: "Generate" }).click();
  return generated;
}

/** From inside the page, so the browser's own headers are on the request */
const post = (page: Page, path: string, body: unknown) =>
  page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { path, body }
  );

test.beforeEach(async ({ request }) => {
  await seedTwoOrganisations();
  await request.post(`${ORGANISATIONS_API}/api/e2e/licence`, { headers: asOrganisation(ACME), data: {} });
  await makePro(request, GLOBEX);
  await request.post(`${PM_STUB_URL}/reset`);
  await fetch(`${AI_STUB_URL}/reset`);
});

test.afterEach(async ({ request }) => {
  for (const who of [ACME, GLOBEX]) {
    await request.post(`${ORGANISATIONS_API}/api/projects/${SHARED_KEY}/pm/interrupt`, {
      headers: { ...asOrganisation(who), authorization: `Bearer ${who.apiToken}` },
    });
  }
});

test.describe("a Free organisation with no key of its own", () => {
  test("is offered its own key or Pro where AI Assist and the PM agent would be", async ({ page }) => {
    const modal = await openNewTaskForm(page, ACME);

    await expect(modal.getByTestId("ai-needs-key")).toContainText("AI Assist runs on your own key on the Free plan.");
    await expect(modal.getByPlaceholder("Describe what you need")).toHaveCount(0);
    await expect(modal.getByRole("link", { name: "Add a key" })).toHaveAttribute("href", "/settings/ai-keys");

    await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}/pm`);
    await expect(page.getByTestId("ai-needs-key")).toContainText("The PM agent runs on your own key on the Free plan.");
    await expect(page.getByPlaceholder(/Message the PM/)).toHaveCount(0);
  });

  test("is refused with 402 at the routes, naming the feature, and no model is called", async ({ page }) => {
    await signInOn(page.context(), ACME);
    await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}`);

    const generation = await post(page, `/api/projects/${SHARED_KEY}/ai/generate-task`, { prompt: "a task" });
    const chat = await post(page, `/api/projects/${SHARED_KEY}/pm/chat`, { message: "hello" });

    expect(generation).toMatchObject({ status: 402, body: { feature: "ai.managed", plan: "free" } });
    expect(chat).toMatchObject({ status: 402, body: { feature: "ai.managed", plan: "free" } });
    expect(await lastAuthorization(AI_STUB_URL)).toBeNull();
    expect(await lastAuthorization(PM_STUB_URL)).toBeNull();
  });

  test("says on the AI keys screen that nothing runs without its own key", async ({ page }) => {
    await signInOn(page.context(), ACME);
    await page.goto(`${originOf(ACME)}/settings/ai-keys`);

    await expect(page.getByText(/it does not run on the Free plan/)).toHaveCount(2);
  });
});

test.describe("a stored key that can no longer be read", () => {
  test("is said to be unreadable on every screen and at the route, and is never replaced by the operator's key, whatever the plan", async ({ page }) => {
    // Sealed under another organisation's data key, which is how a value copied between rows, or a key that was rotated away, reads
    process.env.ENCRYPTION_KEY = E2E_ENCRYPTION_KEY;
    await mongoose.connect(E2E_MONGODB_URI);
    try {
      const settings = mongoose.connection.db!.collection("settings");
      for (const who of [ACME, GLOBEX]) {
        await settings.deleteMany({ organisation: who.organisation });
        await settings.insertOne({
          organisation: who.organisation,
          aiModel: "gpt-4o-mini",
          signUpDomains: [],
          openrouterKey: encryptSecret("sk-or-copied-0123456789", who === ACME ? GLOBEX.organisation : ACME.organisation),
          openrouterKeyHint: "6789",
          openaiKey: encryptSecret("sk-copied-0123456789", who === ACME ? GLOBEX.organisation : ACME.organisation),
          openaiKeyHint: "6789",
        });
      }
    } finally {
      await mongoose.disconnect();
    }

    for (const who of [ACME, GLOBEX]) {
      await signInOn(page.context(), who);

      await page.goto(`${originOf(who)}/settings/ai-keys`);
      await expect(page.getByText("Cannot be read", { exact: true })).toHaveCount(2);
      await expect(page.getByText(/The stored key cannot be read, so every call fails/)).toHaveCount(2);

      await page.goto(`${originOf(who)}/projects/${SHARED_KEY}`);
      await page.getByRole("button", { name: "New task" }).click();
      const modal = page.getByRole("dialog", { name: "New Task" });
      await expect(modal.getByTestId("ai-key-unreadable")).toContainText("AI Assist cannot run: the stored AI key cannot be read");
      await expect(modal.getByPlaceholder("Describe what you need")).toHaveCount(0);
      await page.keyboard.press("Escape");

      await page.goto(`${originOf(who)}/projects/${SHARED_KEY}/pm`);
      await expect(page.getByTestId("ai-key-unreadable")).toContainText("the stored AI key cannot be read");
      await expect(page.getByPlaceholder(/Message the PM/)).toHaveCount(0);

      const chat = await post(page, `/api/projects/${SHARED_KEY}/pm/chat`, { message: "hello" });
      expect(chat, who.slug).toMatchObject({ status: 503, body: { reason: "own_key_unreadable" } });
      expect(await lastAuthorization(PM_STUB_URL), `${who.slug}: the operator's key must not stand in`).toBeNull();
    }
  });
});

test.describe("a Pro organisation with no key of its own", () => {
  test("uses the operator's keys, for AI Assist and for the PM agent", async ({ page }) => {
    const modal = await openNewTaskForm(page, GLOBEX);

    expect((await generate(page, modal)).status()).toBe(200);
    expect(await lastAuthorization(AI_STUB_URL)).toBe(OPERATORS_KEY);

    await page.goto(`${originOf(GLOBEX)}/projects/${SHARED_KEY}/pm`);
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/pm/chat"));
    await page.getByPlaceholder(/Message the PM/).fill(`hello <<${JSON.stringify({ say: "Done." })}>>`);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    expect((await answered).status()).toBe(200);
    await expect(page.getByText("Done.", { exact: true })).toHaveCount(1);
    expect(await lastAuthorization(PM_STUB_URL)).toBe(OPERATORS_KEY);
  });
});

test.describe("an organisation's own key", () => {
  test("turns AI on for a Free organisation, is the key its calls are made with, and is nobody else's", async ({ page, browser }) => {
    await signInOn(page.context(), ACME);

    await test.step("the admin stores both keys on the organisation's own host", async () => {
      await page.goto(`${originOf(ACME)}/settings/ai-keys`);
      for (const [label, value] of [
        ["OpenRouter key", OWN_OPENROUTER],
        ["OpenAI key", OWN_OPENAI],
      ] as const) {
        const card = page.locator("section", { has: page.getByRole("heading", { name: label }) });
        const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/settings/ai-keys"));
        await card.getByLabel(/^Add your/).fill(value);
        await card.getByRole("button", { name: "Save key" }).click();
        expect((await saved).status()).toBe(200);
        await expect(card.getByText(value.slice(-4), { exact: true })).toBeVisible();
      }
    });

    await test.step("AI Assist is back, and the call is made with ACME's key, not the operator's", async () => {
      await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}`);
      await page.getByRole("button", { name: "New task" }).click();
      const modal = page.getByRole("dialog", { name: "New Task" });
      await expect(modal.getByTestId("ai-needs-key")).toHaveCount(0);

      expect((await generate(page, modal)).status()).toBe(200);
      expect(await lastAuthorization(AI_STUB_URL)).toBe(`Bearer ${OWN_OPENAI}`);
    });

    await test.step("the PM agent runs on ACME's OpenRouter key", async () => {
      await page.goto(`${originOf(ACME)}/projects/${SHARED_KEY}/pm`);
      const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/pm/chat"));
      await page.getByPlaceholder(/Message the PM/).fill(`hello <<${JSON.stringify({ say: "Done." })}>>`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      expect((await answered).status()).toBe(200);
      await expect(page.getByText("Done.", { exact: true })).toHaveCount(1);
      expect(await lastAuthorization(PM_STUB_URL)).toBe(`Bearer ${OWN_OPENROUTER}`);
    });

    await test.step("control: GLOBEX has none of it, and still runs on the operator's key", async () => {
      const other = await browser.newContext();
      try {
        const globex = await other.newPage();
        const modal = await openNewTaskForm(globex, GLOBEX);
        expect((await generate(globex, modal)).status()).toBe(200);
        expect(await lastAuthorization(AI_STUB_URL)).toBe(OPERATORS_KEY);

        const state = await globex.evaluate(async () => (await fetch("/api/settings/ai-keys")).json());
        expect(state.providers.openrouter.set).toBe(false);
        expect(state.providers.openai.set).toBe(false);
        expect(JSON.stringify(state)).not.toContain("acme-e2e");
      } finally {
        await other.close();
      }
    });
  });
});
