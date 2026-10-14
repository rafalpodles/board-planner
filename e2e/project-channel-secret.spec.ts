import { test, expect, type Page } from "@playwright/test";
import crypto from "crypto";
import mongoose from "mongoose";
import { E2E_ENCRYPTION_KEY, E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-372. A Slack or Discord incoming-webhook URL is a bearer credential — anyone holding it posts
 * into that room as the integration — and `notificationChannels[].webhookUrl` went into MongoDB in
 * the clear.
 *
 * **What a browser can reach here and the unit tests cannot.** The screen never holds the real URL:
 * it renders `webhookUrlMasked`, which `sanitizeProjectSecrets` computes from the stored string. An
 * `enc:v3:…` envelope is a perfectly parseable URL with a non-special scheme, so masking the stored
 * value without decrypting first yields `null/••••` plus a tail of ciphertext — a settings screen on
 * which no owner can tell one channel from another, and nothing below the browser notices.
 *
 * **The delivery itself** is received in `outbound-delivery.spec.ts` (BP-696), through a channel
 * saved the same way; the decrypt-at-dispatch half is also pinned in `src/lib/notifications.test.ts`.
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

// The envelope the releases before BP-898 wrote: the instance key itself, no organisation in it
function sealedUnderTheInstanceKey(plaintext: string): string {
  const material = Buffer.from(E2E_ENCRYPTION_KEY, "hex");
  const id = crypto.createHash("sha256").update(material).digest("hex").slice(0, 8);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", material, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `enc:v2:${id}:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64")}`;
}

async function seedLegacyPlaintextChannel(name: string, webhookUrl = LEGACY_URL) {
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
            webhookUrl,
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
  expect(body).not.toMatch(/enc:v\d:/);
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
    expect(stored.webhookUrl).toMatch(/^enc:v3:[0-9a-f]{8}:/);

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
    await expect(page.getByText(/^enc:v\d:/)).toHaveCount(0);
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
    const response = await replaced;
    expect(response.status()).toBe(200);

    // PUT answers with the freshest envelope of all — the URL the client typed a moment ago — so
    // it is held to the same three assertions the POST answer is
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(REPLACEMENT_URL);
    expect(body).not.toMatch(/enc:v\d:/);
    expect(body).toContain("webhookUrlMasked");

    const stored = await storedChannel("Releases");
    expect(stored.webhookUrl).not.toContain("typedIntoTheRow");
    expect(stored.webhookUrl).toMatch(/^enc:v3:[0-9a-f]{8}:/);
    // A fresh envelope, not the old one carried over — the replacement really was written
    expect(stored.webhookUrl).not.toBe(first.webhookUrl);
    await expect(page.getByText("https://hooks.slack.com/••••eRow")).toBeVisible();
  });

  test("in a row written before BP-372 is not read, and is sealed by the next save", async ({
    page,
  }) => {
    await seedLegacyPlaintextChannel("Legacy");
    await signIn(page);
    await openTeamChannels(page);

    // The premise, measured rather than assumed: the row really is stored in the clear, and since
    // BP-900 nothing opens it, so the screen shows no host for it until a save seals it
    expect((await storedChannel("Legacy")).webhookUrl).toBe(LEGACY_URL);
    await expect(page.getByText("https://hooks.slack.com/••••p372")).toHaveCount(0);

    // Renaming it touches no URL, and that is the point: an ordinary edit carries the row over
    await page.getByRole("button", { name: "task created for Legacy" }).click();
    const saved = page.waitForResponse(
      (r) => r.url().includes("/notifications") && r.request().method() === "PUT"
    );
    await saveButton(page).click();
    expect((await saved).status()).toBe(200);

    const stored = await storedChannel("Legacy");
    expect(stored.webhookUrl).not.toContain("hooks.slack.com");
    expect(stored.webhookUrl).toMatch(/^enc:v3:[0-9a-f]{8}:/);

    // Reloaded before reading the screen, so what is asserted is the sealed row and not the DOM
    // the trigger had not yet replaced.
    await openTeamChannels(page);
    await expect(page.getByText("https://hooks.slack.com/••••p372")).toBeVisible();
    await expect(page.getByText(/^enc:v\d:/)).toHaveCount(0);
    await expect(page.getByText("null/••••")).toHaveCount(0);
  });

  // BP-900. The instance key opens any organisation's v2 value, so a copy of one lifted from a
  // backup onto another board would have read there; it reads as nothing instead
  test("sealed under the instance key itself is not read, and shows no host", async ({ page }) => {
    await seedLegacyPlaintextChannel("Old", sealedUnderTheInstanceKey(LEGACY_URL));
    await signIn(page);
    await openTeamChannels(page);

    await expect(page.getByText("https://hooks.slack.com/••••p372")).toHaveCount(0);
    await expect(page.getByText("••••", { exact: true })).toBeVisible();
    expect((await storedChannel("Old")).webhookUrl).toMatch(/^enc:v2:/);
  });
});
