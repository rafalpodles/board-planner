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
 * BP-1001. The platform's key runs only the models the operator allows on it (MANAGED_AI_MODELS, set for this server in
 * playwright.config.ts); any other is refused before anything reaches the provider. An organisation's own key runs any.
 * GLOBEX is Pro, so it is on the platform's key until it stores its own.
 */

const OWN_KEY = "sk-or-globex-own-e2e-0123456789";
const ASSIST_MODEL = "anthropic/claude-haiku";
const PM_MODEL = "openai/gpt-oss-120b";
const ALLOWED = "e2e/stub-model, openai/gpt-4o-mini";
const refusal = (model: string) =>
  `The model ${model} is not available on Board Planner's AI key. Choose one of: ${ALLOWED}, or add your organisation's own OpenRouter key in Settings → AI key.`;
const SCRIPTED = `a task <<${JSON.stringify({ title: "From the stub", description: "d", category: "bug", acceptanceCriteria: "" })}>>`;
const SHOTS = "e2e/.artifacts/bp1001";

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
    await db.collection("settings").insertOne({ organisation: GLOBEX.organisation, aiModel: ASSIST_MODEL, pmDefaultModel: "", signUpDomains: [] });
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

  expect(await stub("/requests")).toEqual([]);
  expect((await stub("/last-authorization")).authorization).toBeNull();
  expect((await stub("/last-assist-authorization")).authorization).toBeNull();

  await test.step("Settings → Agents shows both models as refused, at desktop and phone width", async () => {
    await page.goto(`${originOf(GLOBEX)}/settings/agents`);
    const assistNote = page.getByTestId("ai-model-managed");
    await expect(assistNote).toHaveText(
      `⚠${ASSIST_MODEL} is not available on Board Planner's AI key, so it will be refused. Choose one of: ${ALLOWED}, or add your organisation's own OpenRouter key.`
    );
    await expect(page.getByTestId(`pm-model-refused-${SHARED_KEY}`)).toHaveText("Not available on Board Planner's AI key");
    // Blank here, so the projects that name no model fall back to PM_MODEL, which this server's list leaves out
    await expect(page.getByTestId("pm-model-managed")).toHaveText(/^⚠openai\/gpt-6-luna is not available on Board Planner's AI key, so it will be refused\./);
    await page.screenshot({ path: `${SHOTS}/agents-refused-desktop.png` });
    await page.getByTestId(`pm-model-refused-${SHARED_KEY}`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/agents-refused-desktop-row.png` });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expect(assistNote).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await assistNote.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/agents-refused-phone.png` });
    await page.getByTestId(`pm-model-refused-${SHARED_KEY}`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/agents-refused-phone-row.png` });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
  });

  await test.step("control: choosing a model on the list there runs AI Assist on the platform's key", async () => {
    await page.getByLabel("Model", { exact: true }).fill("gpt-4o-mini");
    await expect(page.getByTestId("ai-model-managed")).toHaveText(`On Board Planner's AI key: ${ALLOWED}. Any OpenRouter model works with your organisation's own key.`);
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

  await page.goto(`${originOf(GLOBEX)}/settings/agents`);
  await expect(page.getByTestId("ai-model-managed")).toHaveText("Your organisation's own OpenRouter key is in use, so any OpenRouter model works.");
  await expect(page.getByTestId(`pm-model-refused-${SHARED_KEY}`)).toHaveCount(0);
});
