import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { PM_STUB_URL, RUN_ORGANISATIONS_SERVER } from "../playwright.config";
import { signPlatformRequest } from "../src/lib/platform-request";
import { encryptSecret } from "../src/lib/encryption";
import { E2E_PLATFORM_REQUEST_KEY, e2eLicence } from "./licence-key";
import { E2E_ENCRYPTION_KEY, E2E_MONGODB_URI } from "./seed";
import { GLOBEX, ORGANISATIONS_API, PLATFORM_HOST, SHARED_KEY, originOf, seedTwoOrganisations, signInOn, type OrganisationFixture } from "./organisations";

test.skip(!RUN_ORGANISATIONS_SERVER, "needs the ORGANISATION_DOMAIN server — set E2E_ORGANISATIONS_SERVER=1");

/**
 * BP-1001, BP-1026. The platform's key runs only the allowed providers' models (OpenAI, Anthropic, Google, Mistral); any other is refused before anything reaches the provider.
 * An organisation's own key runs any.
 * GLOBEX is Pro, so it is on the platform's key until it stores its own.
 */

const OWN_KEY = "sk-or-globex-own-e2e-0123456789";
const ASSIST_MODEL = "moonshotai/kimi-k2.6";
const PM_MODEL = "openai/gpt-oss-120b";
const ALLOWED = "OpenAI's own models (openai/…, not gpt-oss), Anthropic's own models (anthropic/…), Google's models on Vertex AI (google/…, not gemma), Mistral's own models (mistralai/…)";
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

// A fill before the page has hydrated is dropped, and the read-back is what tells
async function fillStably(field: Locator, value: string) {
  await expect(async () => {
    await field.fill(value, { timeout: 3_000 });
    await expect(field).toHaveValue(value, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

// A change before the page has hydrated is dropped, and the read-back is what tells
async function selectStably(field: Locator, value: string) {
  await expect(async () => {
    await field.selectOption(value, { timeout: 3_000 });
    await expect(field).toHaveValue(value, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
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
    await page.goto(`${originOf(GLOBEX)}/settings/ai-keys`);
    await selectStably(page.getByLabel("Model", { exact: true }), "openai/gpt-4o-mini");
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

// BP-1006. One field, in Settings → AI key (BP-1024), decides the model of both; a project that names none follows it.
test("AI Assist and a PM agent that names no model of its own run on the one model saved in Settings → AI key", async ({ page }) => {
  await withDb((db) => db.collection("projects").updateOne({ _id: GLOBEX.projectId }, { $unset: { "pm.model": "" } }));
  await signInOn(page.context(), GLOBEX);

  await page.goto(`${originOf(GLOBEX)}/settings/ai-keys`);
  await expect(page.getByLabel("Model", { exact: true })).toHaveCount(1);
  await expect(page.getByLabel("Default model")).toHaveCount(0);
  await selectStably(page.getByLabel("Model", { exact: true }), "openai/gpt-4o-mini");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/settings"));
  await page.getByRole("button", { name: "Save model" }).click();
  expect((await saved).status()).toBe(200);
  await page.goto(`${originOf(GLOBEX)}/settings/agents`);
  await expect(page.getByLabel(`PM model for ${SHARED_KEY}`, { exact: false }).locator("option").first()).toHaveText("Default — openai/gpt-4o-mini");

  expect((await generateOnScreen(page).then((r) => r.response)).status()).toBe(200);
  expect((await stub("/last-assist-request")).model).toBe("openai/gpt-4o-mini");
  await page.keyboard.press("Escape");

  expect((await chatOnScreen(page)).status()).toBe(200);
  await expect(page.getByText("Done.", { exact: true })).toHaveCount(1);
  expect((await stub("/requests")).map((sent: { model?: string }) => sent.model)).toEqual(["openai/gpt-4o-mini"]);
});

// BP-1024. The model is chosen beside the key, from what the key in use runs, and a refusal comes when it is saved
const ownKey = () =>
  withDb(async (db) => {
    process.env.ENCRYPTION_KEY = E2E_ENCRYPTION_KEY;
    await db.collection("settings").updateOne(
      { organisation: GLOBEX.organisation },
      { $set: { openrouterKey: encryptSecret(OWN_KEY, GLOBEX.organisation), openrouterKeyHint: OWN_KEY.slice(-4) } }
    );
  });
const stored = () =>
  withDb(async (db) => ({
    settings: await db.collection("settings").findOne({ organisation: GLOBEX.organisation }),
    pmModel: (await db.collection("projects").findOne({ _id: GLOBEX.projectId }))?.pm?.model as string | undefined,
  }));
const putSettings = (page: Page, body: unknown) =>
  page.evaluate(async (data) => {
    const response = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  }, body);

test("on the platform's key the Model card lists only what that key runs, and a model it would refuse is refused when saved", async ({ page }) => {
  await signInOn(page.context(), GLOBEX);
  await page.goto(`${originOf(GLOBEX)}/settings/ai-keys`);
  const model = page.getByLabel("Model", { exact: true });

  // The model saved before is off the list: it stays the choice shown, and is marked
  await expect(model.locator("option")).toHaveText([
    `${ASSIST_MODEL} — not available on our key`,
    "Anthropic: Claude Haiku",
    "Anthropic: Claude Haiku 5.5",
    "E2E: Marking provider",
    "Google: Gemini 2.5 Flash",
    "Mistral: Large",
    "OpenAI: GPT-4o",
    "OpenAI: GPT-4o Mini",
    "OpenAI: GPT-4o Mini 2026",
    "OpenAI: GPT-6 Luna",
  ]);
  await expect(model.locator("optgroup")).toHaveCount(4);
  await expect(page.getByTestId("ai-model-note")).toHaveText(
    "Board Planner's key runs only models from OpenAI, Anthropic, Google, and Mistral. To use any other model or provider, add your own OpenRouter key above."
  );

  // A provider the DPA does not name is refused, with all four named; one it does is saved
  const refused = await putSettings(page, { aiModel: "deepseek/deepseek-v4" });
  expect(refused).toEqual({ status: 400, body: { error: refusal("deepseek/deepseek-v4") } });
  expect((await stored()).settings?.aiModel).toBe(ASSIST_MODEL);

  // The control: a model on the list is saved
  expect((await putSettings(page, { aiModel: "anthropic/claude-haiku-5.5" })).status).toBe(200);
  expect((await stored()).settings?.aiModel).toBe("anthropic/claude-haiku-5.5");
});

test("on the organisation's own key any model OpenRouter lists can be chosen, and one it does not list is refused with the reason", async ({ page }) => {
  await ownKey();
  await signInOn(page.context(), GLOBEX);
  await page.goto(`${originOf(GLOBEX)}/settings/ai-keys`);
  const model = page.getByLabel("Model", { exact: true });
  await expect(page.getByTestId("ai-model-note")).toContainText("Any OpenRouter model runs on this key");

  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/settings"));
  await fillStably(model, "anthropic/claude-haiku-5.5");
  await page.getByRole("button", { name: "Save model" }).click();
  expect((await saved).status()).toBe(200);
  expect((await stored()).settings?.aiModel).toBe("anthropic/claude-haiku-5.5");

  const typo = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/settings"));
  await fillStably(model, "anthropic/claude-haiku-9");
  await page.getByRole("button", { name: "Save model" }).click();
  expect((await typo).status()).toBe(400);
  await expect(page.getByRole("alert").filter({ hasText: "OpenRouter has no model anthropic/claude-haiku-9" })).toBeVisible();
  expect((await stored()).settings?.aiModel).toBe("anthropic/claude-haiku-5.5");
});

test("the own key cannot be removed while a model only it runs is in use, and can once none is", async ({ page }) => {
  await ownKey();
  await signInOn(page.context(), GLOBEX);
  await page.goto(`${originOf(GLOBEX)}/settings/ai-keys`);

  const attempt = async () => {
    const answered = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/settings/ai-keys"));
    await page.getByRole("button", { name: "Remove key" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove key" }).click();
    return answered;
  };

  expect((await attempt()).status()).toBe(409);
  await expect(page.getByRole("alert").filter({ hasText: `Your own key is what runs ${ASSIST_MODEL}, ${PM_MODEL}, and Board Planner's key does not.` })).toBeVisible();
  expect((await stored()).settings?.openrouterKey).toBeTruthy();

  // The control: with models the platform's key runs, the same removal goes through
  await withDb(async (db) => {
    await db.collection("settings").updateOne({ organisation: GLOBEX.organisation }, { $set: { aiModel: "openai/gpt-4o" } });
    await db.collection("projects").updateOne({ _id: GLOBEX.projectId }, { $unset: { "pm.model": "" } });
  });
  await page.reload();
  expect((await attempt()).status()).toBe(200);
  expect((await stored()).settings?.openrouterKey).toBeUndefined();
});

test("a key OpenRouter rejects is refused when saved and stored nowhere, and one it accepts is stored", async ({ page }) => {
  await signInOn(page.context(), GLOBEX);
  await page.goto(`${originOf(GLOBEX)}/settings/ai-keys`);
  const field = page.getByLabel("Add your OpenRouter key");
  const save = () => page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/settings/ai-keys"));

  const rejected = save();
  await fillStably(field, "sk-or-v1-rejected-0123456789");
  await page.getByRole("button", { name: "Save key" }).click();
  expect((await rejected).status()).toBe(400);
  await expect(page.getByRole("alert").filter({ hasText: "OpenRouter does not accept this key" })).toBeVisible();
  expect((await stored()).settings?.openrouterKey).toBeUndefined();

  const accepted = save();
  await fillStably(field, "sk-or-v1-accepted-0123456789");
  await page.getByRole("button", { name: "Save key" }).click();
  expect((await accepted).status()).toBe(200);
  expect((await stored()).settings?.openrouterKey).toMatch(/^enc:v3:/);
});
