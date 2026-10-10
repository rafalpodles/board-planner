import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { PM_STUB_URL, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { signPlatformRequest } from "../src/lib/platform-request";
import { encryptSecret } from "../src/lib/encryption";
import { E2E_PLATFORM_REQUEST_KEY, e2eLicence } from "./licence-key";
import { E2E_ENCRYPTION_KEY, E2E_MONGODB_URI } from "./seed";
import { GLOBEX, ORGANISATIONS_API, PLATFORM_HOST, SHARED_KEY, originOf, seedTwoOrganisations, signInOn, type OrganisationFixture } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

/**
 * BP-1001. The platform's key runs only OpenAI's own models; any other is refused before anything reaches the provider.
 * An organisation's own key runs any.
 * GLOBEX is Pro, so it is on the platform's key until it stores its own.
 */

const OWN_KEY = "sk-or-globex-own-e2e-0123456789";
const ASSIST_MODEL = "anthropic/claude-haiku";
const PM_MODEL = "openai/gpt-oss-120b";
const ALLOWED = "OpenAI's own models (openai/…, not gpt-oss)";
const refusal = (model: string) =>
  `The model ${model} is not available on Board Planner's AI key. Choose one of: ${ALLOWED}, or add your organisation's own OpenRouter key in Settings → AI key.`;
const SCRIPTED = `a task <<${JSON.stringify({ title: "From the stub", description: "d", category: "bug", acceptanceCriteria: "" })}>>`;

async function makePro(request: APIRequestContext, who: OrganisationFixture) {
  const path = `/api/platform/organisations/${who.organisation.toHexString()}/licence`;
  const body = Buffer.from(JSON.stringify({ licenceKey: e2eLicence({ customer: `${who.slug} customer`, organisation: who.organisation.toHexString() }) }));
  const headers = signPlatformRequest({ method: "POST", host: PLATFORM_HOST, path, body }, E2E_PLATFORM_REQUEST_KEY);
  const response = await request.post(`${ORGANISATIONS_API}${path}`, { headers: { host: PLATFORM_HOST, "content-type": "application/json", ...headers }, data: body });
  expect(response.status(), await response.text()).toBe(200);
}

async function withDb<T>(run: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return await run(mongoose.connection.db!);
  } finally {
    await mongoose.disconnect();
  }
}

const stub = async (path: string) => (await fetch(`${PM_STUB_URL}${path}`)).json();

async function generateOnScreen(page: Page) {
  await page.goto(`${originOf(GLOBEX)}/projects/${SHARED_KEY}`);
  await page.getByRole("button", { name: "New task" }).click();
  const modal = page.getByRole("dialog", { name: "New Task" });
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/ai/generate-task"));
  await modal.getByPlaceholder("Describe what you need").fill(SCRIPTED);
  await modal.getByRole("button", { name: "Generate" }).click();
  return { response: await answered };
}

async function chatOnScreen(page: Page) {
  await page.goto(`${originOf(GLOBEX)}/projects/${SHARED_KEY}/pm`);
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/pm/chat"));
  await page.getByPlaceholder(/Message the PM/).fill(`hello <<${JSON.stringify({ say: "Done." })}>>`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  return answered;
}

test.beforeEach(async ({ request }) => {
  await seedTwoOrganisations();
  await makePro(request, GLOBEX);
  await withDb(async (db) => {
    await db.collection("settings").deleteMany({ organisation: GLOBEX.organisation });
    await db.collection("settings").insertOne({ organisation: GLOBEX.organisation, aiModel: ASSIST_MODEL, signUpDomains: [] });
    await db.collection("projects").updateOne({ _id: GLOBEX.projectId }, { $set: { "pm.model": PM_MODEL } });
  });
  await request.post(`${PM_STUB_URL}/reset`);
});

test.afterEach(async () => {
  await withDb((db) => db.collection("settings").deleteMany({ organisation: GLOBEX.organisation }));
});

test("on the platform's key a model off the list is refused with the models that run and the own key as the way out, and nothing reaches the provider", async ({ page }) => {
  await signInOn(page.context(), GLOBEX);

  await test.step("AI Assist", async () => {
    const { response } = await generateOnScreen(page);
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ reason: "model_not_managed", model: ASSIST_MODEL });
    await expect(page.getByText(refusal(ASSIST_MODEL), { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  await test.step("the PM agent", async () => {
    const response = await chatOnScreen(page);
    expect(response.status()).toBe(403);
    await expect(page.getByText(refusal(PM_MODEL), { exact: true })).toBeVisible();
  });

  await test.step("the owner's Run a review now", async () => {
    await page.goto(`${originOf(GLOBEX)}/projects/${SHARED_KEY}/settings?section=pm`);
    const answered = page.waitForResponse((r) => r.url().endsWith("/pm/review") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Run a review now" }).click();
    expect((await answered).status()).toBe(403);
    await expect(page.getByText(refusal(PM_MODEL), { exact: true })).toBeVisible();
  });

  expect(await stub("/requests")).toEqual([]);
  expect((await stub("/last-authorization")).authorization).toBeNull();
  expect((await stub("/last-assist-authorization")).authorization).toBeNull();

  await test.step("control: choosing a model on the list there runs AI Assist on the platform's key", async () => {
    await page.goto(`${originOf(GLOBEX)}/settings/agents`);
    await page.getByLabel("Model", { exact: true }).fill("gpt-4o-mini");
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/settings"));
    await page.getByRole("button", { name: "Save model" }).click();
    expect((await saved).status()).toBe(200);

    const { response } = await generateOnScreen(page);
    expect(response.status()).toBe(200);
    expect((await stub("/last-assist-authorization")).authorization).toBe("Bearer e2e-stub-key");
    expect((await stub("/last-assist-request")).model).toBe("openai/gpt-4o-mini");
  });
});

test("the same models run on the organisation's own key", async ({ page }) => {
  process.env.ENCRYPTION_KEY = E2E_ENCRYPTION_KEY;
  await withDb((db) =>
    db.collection("settings").updateOne(
      { organisation: GLOBEX.organisation },
      { $set: { openrouterKey: encryptSecret(OWN_KEY, GLOBEX.organisation), openrouterKeyHint: OWN_KEY.slice(-4) } }
    )
  );
  await signInOn(page.context(), GLOBEX);

  const { response } = await generateOnScreen(page);
  expect(response.status()).toBe(200);
  expect((await stub("/last-assist-request")).model).toBe(ASSIST_MODEL);
  expect((await stub("/last-assist-authorization")).authorization).toBe(`Bearer ${OWN_KEY}`);
  await page.keyboard.press("Escape");

  expect((await chatOnScreen(page)).status()).toBe(200);
  await expect(page.getByText("Done.", { exact: true })).toHaveCount(1);
  expect((await stub("/last-authorization")).authorization).toBe(`Bearer ${OWN_KEY}`);
  expect((await stub("/requests")).map((sent: { model?: string }) => sent.model)).toEqual([PM_MODEL]);
});

// BP-1006. One field, in Settings → Agents, decides the model of both; a project that names none follows it.
test("AI Assist and a PM agent that names no model of its own run on the one model saved in Settings → Agents", async ({ page }) => {
  await withDb((db) => db.collection("projects").updateOne({ _id: GLOBEX.projectId }, { $unset: { "pm.model": "" } }));
  await signInOn(page.context(), GLOBEX);

  await page.goto(`${originOf(GLOBEX)}/settings/agents`);
  await expect(page.getByLabel("Model", { exact: true })).toHaveCount(1);
  await expect(page.getByLabel("Default model")).toHaveCount(0);
  await page.getByLabel("Model", { exact: true }).fill("gpt-4o-mini");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/settings"));
  await page.getByRole("button", { name: "Save model" }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByLabel(`PM model for ${SHARED_KEY}`, { exact: false })).toHaveAttribute("placeholder", "gpt-4o-mini");

  expect((await generateOnScreen(page).then((r) => r.response)).status()).toBe(200);
  expect((await stub("/last-assist-request")).model).toBe("openai/gpt-4o-mini");
  await page.keyboard.press("Escape");

  expect((await chatOnScreen(page)).status()).toBe(200);
  await expect(page.getByText("Done.", { exact: true })).toHaveCount(1);
  expect((await stub("/requests")).map((sent: { model?: string }) => sent.model)).toEqual(["openai/gpt-4o-mini"]);
});
