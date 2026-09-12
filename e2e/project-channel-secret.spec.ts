import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-372. A Slack or Discord incoming-webhook URL is a bearer credential — anyone holding it posts
 * into that room as the integration — and `notificationChannels[].webhookUrl` went into MongoDB in
 * the clear.
 *
 * **What a browser can reach here and the unit tests cannot.** The screen never holds the real URL:
 * it renders `webhookUrlMasked`, which `sanitizeProjectSecrets` computes from the stored string. An
 * `enc:v2:…` envelope is a perfectly parseable URL with a non-special scheme, so masking the stored
 * value without decrypting first yields `null/••••` plus a tail of ciphertext — a settings screen on
 * which no owner can tell one channel from another, and nothing below the browser notices.
 *
 * **What no spec in this suite can reach: the delivery.** `isAllowedWebhookUrl` demands `https:` and
 * refuses private addresses, and `webhook-receiver.mjs` is http on 127.0.0.1 — the same wall
 * `external-integrations.spec.ts` documents. So a channel here can never be posted to, encrypted or
 * not, and the decrypt-at-dispatch half is proven in `src/lib/notifications.test.ts` instead.
 */
test.beforeEach(seed);

const RAW_URL = "https://hooks.slack.com/services/T0E2E/B0E2E/writeThroughTheForm";
const REPLACEMENT_URL = "https://hooks.slack.com/services/T0E2E/B0E2E/typedIntoTheRow";
const LEGACY_URL = "https://hooks.slack.com/services/T0OLD/B0OLD/writtenBeforeBp372";

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

/** The stored channel, read the way an operator with the database would read it. */
async function storedChannel(name: string) {
  const project = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
  const channel = (project?.notificationChannels ?? []).find(
    (ch: { name: string }) => ch.name === name
  );
  if (!channel) throw new Error(`no stored channel called ${name}`);
  return channel as { name: string; webhookUrl: string };
}

async function seedLegacyPlaintextChannel(name: string) {
  await (await db()).collection("projects").updateOne(
    { _id: PROJECT_ID },
    {
      $set: {
        notificationChannels: [
          {
            _id: new mongoose.Types.ObjectId(),
            type: "slack",
            name,
            // Exactly the shape every row written before BP-372 has: no envelope, no key id
            webhookUrl: LEGACY_URL,
            events: ["task_created"],
            enabled: true,
          },
        ],
      },
    }
  );
}

async function openTeamChannels(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=integrations`);

  // Two shapes, both normal: a board with nothing connected shows the catalogue tiles outright,
  // and one with a connection folds them behind "Add integration". Neither is assumed — the same
  // reasoning `project-settings.spec.ts` records for the webhooks row.
  const picker = page.getByRole("button", { name: /Add integration/ });
  const row = page.getByRole("button", { name: /^Team channels/ });
  await expect(picker.or(row).first()).toBeVisible();
  if (await picker.isVisible()) await picker.click();

  const form = page.getByLabel("New channel type");
  // Clicked in a loop rather than once: Playwright's actionability checks pass against a rendered
  // but unhydrated DOM, the click is dispatched once and never retried, and a swallowed one here
  // surfaces three assertions later as a missing field.
  await expect(async () => {
    if (!(await form.isVisible())) await row.first().click();
    await expect(form).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

const saveButton = (page: Page) => page.getByRole("button", { name: "Save changes" });

async function addChannelThroughTheForm(page: Page, name: string, url: string) {
  await page.getByLabel("New channel name").fill(name);
  await page.getByLabel("New channel webhook URL").fill(url);
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // The save bar's button relabels itself to "Saving…" the instant it is clicked, so waiting for
  // it to go away returns at click time. The POST's own response is what says the write landed.
  const written = page.waitForResponse(
    (r) => r.url().includes("/notifications") && r.request().method() === "POST"
  );
  await saveButton(page).click();
  const response = await written;
  expect(response.status()).toBe(201);

  // The wire, not just the database: the route answers with the channel list it just wrote, and
  // that answer is the one surface `sanitizeProjectSecrets` has to strip on the way out
  const body = JSON.stringify(await response.json());
  expect(body).not.toContain(url);
  expect(body).not.toContain("enc:v2:");
  expect(body).toContain("webhookUrlMasked");
}

test.describe("a project's chat webhook URL", () => {
  test("is stored encrypted when it is added through the settings form", async ({ page }) => {
    await signIn(page);
    await openTeamChannels(page);
    await addChannelThroughTheForm(page, "Releases", RAW_URL);

    const stored = await storedChannel("Releases");

    // The checklist item, stated as the operator's question: is my webhook in this document?
    expect(stored.webhookUrl).not.toContain(RAW_URL);
    expect(stored.webhookUrl).not.toContain("hooks.slack.com");
    expect(stored.webhookUrl).not.toContain("writeThroughTheForm");
    expect(stored.webhookUrl).toMatch(/^enc:v2:[0-9a-f]{8}:/);

    // …and the control, because ciphertext nobody can read back is not a fix: the row is still on
    // screen, named by the host it points at rather than by the envelope it is stored as
    await expect(page.getByText("https://hooks.slack.com/••••Form")).toBeVisible();
  });

  test("is still shown by its host when the row is reopened from the database", async ({ page }) => {
    await signIn(page);
    await openTeamChannels(page);
    await addChannelThroughTheForm(page, "Releases", RAW_URL);

    // A fresh load: the mask now comes from the stored envelope rather than from the draft the
    // form was holding, which is the read the unmasked ciphertext would have broken
    await openTeamChannels(page);
    await expect(page.getByText("https://hooks.slack.com/••••Form")).toBeVisible();
    await expect(page.getByText(/^enc:v2:/)).toHaveCount(0);
    await expect(page.getByText("null/••••")).toHaveCount(0);
  });

  test("is stored encrypted when an existing row's URL is replaced", async ({ page }) => {
    await signIn(page);
    await openTeamChannels(page);
    await addChannelThroughTheForm(page, "Releases", RAW_URL);
    const first = await storedChannel("Releases");

    await page.getByRole("button", { name: "Replace Webhook URL for Releases" }).click();
    await page.getByLabel("Webhook URL for Releases", { exact: true }).fill(REPLACEMENT_URL);
    const replaced = page.waitForResponse(
      (r) => r.url().includes("/notifications") && r.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Save Webhook URL for Releases" }).click();
    expect((await replaced).status()).toBe(200);

    const stored = await storedChannel("Releases");
    expect(stored.webhookUrl).not.toContain("typedIntoTheRow");
    expect(stored.webhookUrl).toMatch(/^enc:v2:[0-9a-f]{8}:/);
    // A fresh envelope, not the old one carried over — the replacement really was written
    expect(stored.webhookUrl).not.toBe(first.webhookUrl);
    await expect(page.getByText("https://hooks.slack.com/••••eRow")).toBeVisible();
  });

  test("survives in a row written before BP-372, and is migrated by the next save", async ({
    page,
  }) => {
    await seedLegacyPlaintextChannel("Legacy");
    await signIn(page);
    await openTeamChannels(page);

    // The premise, measured rather than assumed: the row really is stored in the clear, and the
    // screen renders it as well as any other — a plaintext URL must not become unreadable
    expect((await storedChannel("Legacy")).webhookUrl).toBe(LEGACY_URL);
    await expect(page.getByText("https://hooks.slack.com/••••p372")).toBeVisible();

    // Renaming it touches no URL, and that is the point: an ordinary edit carries the row over
    await page.getByRole("button", { name: "task created for Legacy" }).click();
    const saved = page.waitForResponse(
      (r) => r.url().includes("/notifications") && r.request().method() === "PUT"
    );
    await saveButton(page).click();
    expect((await saved).status()).toBe(200);

    const stored = await storedChannel("Legacy");
    expect(stored.webhookUrl).not.toContain("hooks.slack.com");
    expect(stored.webhookUrl).toMatch(/^enc:v2:[0-9a-f]{8}:/);

    // Reloaded before reading the screen. The same masked string was already on it before the save
    // — `decryptSecret` passes plaintext through, so both states mask identically — and asserting
    // it in place would be satisfied by the DOM the trigger had not yet replaced.
    await openTeamChannels(page);
    await expect(page.getByText("https://hooks.slack.com/••••p372")).toBeVisible();
    await expect(page.getByText(/^enc:v2:/)).toHaveCount(0);
    await expect(page.getByText("null/••••")).toHaveCount(0);
  });
});
