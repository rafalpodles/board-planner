import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { PM_STUB_URL } from "../playwright.config";
import { ADMIN_AUTH } from "./api";
import { E2E_MONGODB_URI, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-652. An organisation can store its own OpenRouter key, and the PM agent and AI Assist are both made
 * with the key it stored, not with the one in the server's environment.
 *
 * Which key a call used is not visible in anything the page shows, so the model stub reports the
 * Authorization header of the last PM call and of the last AI Assist call it received. The server here is the self-hosted one: its
 * environment holds `e2e-stub-key`, which is therefore what a call uses when the organisation has
 * stored nothing, and what the control at the end of each test reads.
 */

const OWN_OPENROUTER = "sk-or-own-e2e-0123456789";
const ENVIRONMENT_KEY = "Bearer e2e-stub-key";

async function lastAuthorization(which: "pm" | "assist"): Promise<string | null> {
  return (await (await fetch(`${PM_STUB_URL}/last-${which === "pm" ? "" : "assist-"}authorization`)).json()).authorization;
}

async function storedKeys(): Promise<Record<string, string> | null> {
  const dbName = new URL(E2E_MONGODB_URI.replace(/^mongodb/, "http")).pathname.slice(1);
  if (!dbName.endsWith("_e2e")) throw new Error(`Refusing to read "${dbName}": this only runs against *_e2e`);
  await mongoose.connect(E2E_MONGODB_URI);
  try {
    return (await mongoose.connection.db!.collection("settings").findOne({}, { projection: { openrouterKey: 1 } })) as
      | Record<string, string>
      | null;
  } finally {
    await mongoose.disconnect();
  }
}

const chatBox = (page: Page) => page.getByPlaceholder(/Message the PM/);

// `replies` is how many answers the thread holds once this one lands: the earlier turns are still on screen
async function askThePm(page: Page, prompt: string, replies: number) {
  await page.goto(`/projects/${PROJECT_KEY}/pm`);
  await expect(chatBox(page)).toBeVisible();
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/pm/chat"));
  await chatBox(page).fill(`${prompt} <<${JSON.stringify({ say: "Done." })}>>`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await answered).status()).toBe(200);
  await expect(page.getByText("Done.", { exact: true })).toHaveCount(replies);
}

async function saveKey(page: Page, value: string) {
  const card = page.locator("section", { has: page.getByRole("heading", { name: "OpenRouter key" }) });
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/settings/ai-keys"));
  await card.getByLabel(/^(Add|Replace) your/).fill(value);
  await card.getByRole("button", { name: /Save key|Replace key/ }).click();
  expect((await saved).status()).toBe(200);
  return card;
}

test.beforeEach(async ({ request }) => {
  await seed();
  await request.post(`${PM_STUB_URL}/reset`);
});

test.afterEach(async ({ request }) => {
  await request.post(`/api/projects/${PROJECT_KEY}/pm/interrupt`, { headers: ADMIN_AUTH });
});

test("the PM agent is called with the key the admin stored, and with the server's again once it is removed", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/settings/ai-keys");
  await expect(page.getByRole("heading", { name: "AI key", exact: true })).toBeVisible();

  await test.step("the key is stored sealed, and the page shows only how it ends", async () => {
    const card = await saveKey(page, OWN_OPENROUTER);

    await expect(card.getByText(OWN_OPENROUTER.slice(-4), { exact: true })).toBeVisible();
    // A password field's value is not in the markup, so the field itself is what is read
    await expect(page.getByLabel("Replace your OpenRouter key")).toHaveValue("");
    const row = await storedKeys();
    expect(row?.openrouterKey).toMatch(/^enc:v3:/);
    expect(row?.openrouterKey).not.toContain(OWN_OPENROUTER);
  });

  await test.step("a turn is made with it, not with the environment's", async () => {
    await askThePm(page, "Which key is this?", 1);
    expect(await lastAuthorization("pm")).toBe(`Bearer ${OWN_OPENROUTER}`);
  });

  await test.step("control: with the key removed the same turn uses the server's", async () => {
    await page.goto("/settings/ai-keys");
    const removed = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/settings/ai-keys"));
    await page.getByRole("button", { name: "Remove key" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove key" }).click();
    expect((await removed).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Remove key" })).toHaveCount(0);
    expect((await storedKeys())?.openrouterKey).toBeUndefined();

    await askThePm(page, "And now?", 2);
    expect(await lastAuthorization("pm")).toBe(ENVIRONMENT_KEY);
  });
});

test("AI Assist is called with the same key the admin stored, and with the server's again once it is removed", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/settings/ai-keys");
  await saveKey(page, OWN_OPENROUTER);

  const generate = async () => {
    await page.goto(`/projects/${PROJECT_KEY}`);
    await page.getByRole("button", { name: "New task" }).click();
    const modal = page.getByRole("dialog", { name: "New Task" });
    const generated = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/ai/generate-task"));
    await modal.getByPlaceholder("Describe what you need").fill(`a task <<${JSON.stringify({ title: "Own key", description: "d", category: "bug", acceptanceCriteria: "" })}>>`);
    await modal.getByRole("button", { name: "Generate" }).click();
    expect((await generated).status()).toBe(200);
  };

  await generate();
  expect(await lastAuthorization("assist")).toBe(`Bearer ${OWN_OPENROUTER}`);

  await page.goto("/settings/ai-keys");
  const removed = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/settings/ai-keys"));
  await page.getByRole("button", { name: "Remove key" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove key" }).click();
  expect((await removed).status()).toBe(200);

  await generate();
  expect(await lastAuthorization("assist")).toBe(ENVIRONMENT_KEY);
});

test("a member is turned away from the AI key, on screen and at the route", async ({ page }) => {
  await signIn(page, "member");

  await page.goto("/settings/ai-keys");
  await expect(page).toHaveURL(/\/projects/);

  // From inside the page, so the browser's own Sec-Fetch-Site is on the request and the refusal read is the role's, not the CSRF check's
  const answers = await page.evaluate(async (key) => {
    const put = await fetch("/api/settings/ai-keys", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openrouterKey: key }),
    });
    const get = await fetch("/api/settings/ai-keys");
    return { put: [put.status, (await put.json()).error], get: [get.status, (await get.json()).error] };
  }, OWN_OPENROUTER);
  expect(answers).toEqual({ put: [403, "Forbidden"], get: [403, "Forbidden"] });
  expect((await storedKeys())?.openrouterKey).toBeUndefined();
});

test("a key that is too short is refused on screen, and nothing is stored", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/settings/ai-keys");

  const card = page.locator("section", { has: page.getByRole("heading", { name: "OpenRouter key" }) });
  const refused = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/settings/ai-keys"));
  await card.getByLabel("Add your OpenRouter key").fill("short");
  await card.getByRole("button", { name: "Save key" }).click();

  expect((await refused).status()).toBe(400);
  await expect(card.getByRole("alert")).toContainText(/must be 20 to 300 printable characters/);
  expect((await storedKeys())?.openrouterKey).toBeUndefined();
});
