import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { CODA_STUB_URL, GITHUB_STUB_URL } from "../playwright.config";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-472. `IntegrationsSection.tsx`'s webhook half is covered thoroughly; everything beside it —
 * shared Slack/Discord channels, Coda, GitLab's host/token handling, a refused sync as a person
 * sees it, and the Connections picker itself — was not.
 *
 * **What no spec here can reach: a real chat-channel delivery.** `isAllowedWebhookUrl` demands
 * `https:` and refuses a private address, with no non-production carve-out — the same wall
 * `project-channel-secret.spec.ts` and `notification-grid-delivery.spec.ts` already document for
 * this exact screen. So "enable/disable and the per-event chips decide whether a delivery is
 * attempted" is proven at the point that wall makes reachable: the settings themselves persist
 * correctly, and `dispatchNotifications`'s eligibility filter is pinned in `notifications.test.ts`
 * ("which channels are eligible").
 *
 * **Coda is different, and reachable.** Its host goes through `isAllowedMcpServerUrl` at save
 * time (a public-https-or-loopback-outside-production rule already shared with the MCP server
 * field), but `codaFetch` itself was calling `safeFetch` with no `DestinationOptions` — a silent,
 * always-on refusal regardless of environment. Given `GITHUB_DESTINATION` already carries the
 * identical carve-out for GitHub's sync (BP-443), this file adds the Coda twin (`CODA_DESTINATION`
 * in `src/lib/coda.ts`) rather than leaving Coda's sync unreachable for the same reason chat
 * channels are — production is unaffected (`NODE_ENV` is never anything else there), and
 * `e2e/coda-stub.mjs` is what actually exercises the sync route end to end below.
 *
 * **GitLab's checklist items don't need a live call at all.** The host field, the token-clearing
 * behaviour and Disconnect are all settings-form and database state; `tokensInvalidatedByHostChange`
 * itself is already exhaustively unit-tested in `host-bound-secrets.test.ts` — what was missing was
 * the real save flow proving the route actually calls it.
 *
 * **The "test button" the ticket named does not exist as its own control.** There is one Coda
 * action, "Sync tasks now", and the sync route validates the table's columns before it pushes any
 * row — so a sync with the wrong columns *is* the test, and is covered as its own case below.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings?section=integrations`;
const saveButton = (page: Page) => page.getByRole("button", { name: "Save changes" });
const lastToast = (page: Page) => page.getByTestId("toast").last();

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("no database handle");
  return handle;
}

async function storedProject(): Promise<Record<string, unknown>> {
  const project = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
  if (!project) throw new Error("no stored project");
  return project as unknown as Record<string, unknown>;
}

/** Opens the named row in the Connections picker, adding it from the catalogue first if needed. */
async function openIntegration(page: Page, namePattern: RegExp) {
  await page.goto(SETTINGS);
  const picker = page.getByRole("button", { name: /Add integration/ });
  const row = page.getByRole("button", { name: namePattern });
  await expect(picker.or(row).first()).toBeVisible();
  if (!(await row.first().isVisible()) && (await picker.isVisible())) await picker.click();

  // Playwright's actionability check can pass against a rendered-but-unhydrated catalogue tile;
  // a swallowed click here surfaces three assertions later as a missing field (mirrors
  // project-channel-secret.spec.ts's openTeamChannels).
  await expect(async () => {
    if (!(await row.first().isVisible())) {
      const tile = page.getByRole("button", { name: namePattern });
      await tile.first().click();
    }
    await row.first().click();
  }).toPass({ timeout: 20_000 });
}

test.beforeEach(seed);

test.describe("shared chat channels", () => {
  test("adding, disabling and re-enabling a channel persists through a reload", async ({ page }) => {
    await signIn(page);
    await openIntegration(page, /^Team channels/);

    await page.getByLabel("New channel name").fill("Deploys");
    await page.getByLabel("New channel webhook URL").fill("https://hooks.slack.com/services/T0/B0/x");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    const created = page.waitForResponse(
      (r) => r.url().includes("/notifications") && r.request().method() === "POST"
    );
    await saveButton(page).click();
    await created;

    const active = page.getByRole("button", { name: "Enabled for Deploys" });
    await expect(active).toHaveAttribute("aria-pressed", "true");
    await expect(active).toHaveText("Active");

    const disabled = page.waitForResponse(
      (r) => r.url().includes("/notifications") && r.request().method() === "PUT"
    );
    await active.click();
    await saveButton(page).click();
    await disabled;
    await expect(active).toHaveAttribute("aria-pressed", "false");
    await expect(active).toHaveText("Disabled");

    // The control against a reload that merely kept the optimistic DOM state around
    await page.reload();
    await openIntegration(page, /^Team channels/);
    await expect(page.getByRole("button", { name: "Enabled for Deploys" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  test("the per-event chips persist which events are attached to a channel", async ({ page }) => {
    await signIn(page);
    await openIntegration(page, /^Team channels/);

    await page.getByLabel("New channel name").fill("Comments only");
    await page.getByLabel("New channel webhook URL").fill("https://hooks.slack.com/services/T0/B1/x");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const created = page.waitForResponse(
      (r) => r.url().includes("/notifications") && r.request().method() === "POST"
    );
    await saveButton(page).click();
    await created;

    // Every event starts on (addChannel seeds WEBHOOK_EVENTS in full) — turn two off, leave one on
    await page.getByRole("button", { name: "task created for Comments only" }).click();
    await page.getByRole("button", { name: "status changed for Comments only" }).click();

    const saved = page.waitForResponse(
      (r) => r.url().includes("/notifications") && r.request().method() === "PUT"
    );
    await saveButton(page).click();
    await saved;

    await page.reload();
    await openIntegration(page, /^Team channels/);
    await expect(
      page.getByRole("button", { name: "task created for Comments only" })
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.getByRole("button", { name: "status changed for Comments only" })
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.getByRole("button", { name: "comment added for Comments only" })
    ).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("a channel's masked URL", () => {
  test("survives an unrelated save, and can be deliberately replaced", async ({ page }) => {
    await signIn(page);
    await openIntegration(page, /^Team channels/);

    await page.getByLabel("New channel name").fill("Alerts");
    await page.getByLabel("New channel webhook URL").fill("https://hooks.slack.com/services/T0/B2/original");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const created = page.waitForResponse(
      (r) => r.url().includes("/notifications") && r.request().method() === "POST"
    );
    await saveButton(page).click();
    await created;

    const before = ((await storedProject()).notificationChannels as { webhookUrl: string }[]).find(
      (c) => c
    );
    const beforeUrl = (before as { webhookUrl: string }).webhookUrl;

    // Unrelated: toggle a chip and save again, never touching the SecretField
    await page.getByRole("button", { name: "status changed for Alerts" }).click();
    const unrelatedSave = page.waitForResponse(
      (r) => r.url().includes("/notifications") && r.request().method() === "PUT"
    );
    await saveButton(page).click();
    await unrelatedSave;

    const afterUnrelated = ((await storedProject()).notificationChannels as { webhookUrl: string }[])[0];
    expect(afterUnrelated.webhookUrl).toBe(beforeUrl);

    // Deliberate: the SecretField's own Replace flow
    await page.getByRole("button", { name: "Replace Webhook URL for Alerts" }).click();
    // getByLabel matches by substring against every aria-label, which also catches the "Save
    // Webhook URL for Alerts" / "Cancel Webhook URL for Alerts" buttons revealed by Replace —
    // getByRole with the textbox role is the unambiguous one Playwright itself suggests
    await page
      .getByRole("textbox", { name: "Webhook URL for Alerts" })
      .fill("https://hooks.slack.com/services/T0/B2/replaced");
    const replaced = page.waitForResponse(
      (r) => r.url().includes("/notifications") && r.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Save Webhook URL for Alerts" }).click();
    await replaced;

    const afterReplace = ((await storedProject()).notificationChannels as { webhookUrl: string }[])[0];
    expect(afterReplace.webhookUrl).not.toBe(beforeUrl);
  });
});

test.describe("Coda", () => {
  async function configureCoda(page: Page, tableId: string) {
    await openIntegration(page, /^Coda/);
    await page.getByLabel("Doc ID").fill("doc-e2e");
    await page.getByLabel("Table ID or name").fill(tableId);
    await page.getByLabel("Host").fill(CODA_STUB_URL);
    await page.getByLabel("API token").fill("coda-e2e-token");
    const saved = page.waitForResponse(
      (r) => r.url().endsWith(`/api/projects/${PROJECT_KEY}`) && r.request().method() === "PUT"
    );
    await saveButton(page).click();
    await saved;
  }

  test("is configured, synced and disconnected through the UI", async ({ page, request }) => {
    await request.post(`${CODA_STUB_URL}/control`, { data: {} }); // default columns: every one present
    await signIn(page);
    await configureCoda(page, "table-1");

    const syncButton = page.getByRole("button", { name: "Sync tasks now" });
    await expect(syncButton).toBeVisible();
    const synced = page.waitForResponse(
      (r) => r.url().endsWith(`/api/projects/${PROJECT_KEY}/coda/sync`)
    );
    await syncButton.click();
    const syncResponse = await synced;
    expect(syncResponse.status()).toBe(200);
    await expect(lastToast(page)).toHaveText(/Synced \d+ tasks? to Coda/);

    const upsert = await (await request.get(`${CODA_STUB_URL}/last-upsert`)).json();
    expect(upsert.requestCount).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByLabel("Doc ID")).toHaveValue("");
    const stored = await storedProject();
    expect(stored.codaDocId).toBe("");
    expect(stored.codaTokenSet).toBeFalsy();
  });

  test("reports which columns are missing, and does not push any row", async ({ page, request }) => {
    await request.post(`${CODA_STUB_URL}/control`, { data: { columns: ["Key", "Title"] } });
    await signIn(page);
    await configureCoda(page, "table-missing-columns");

    await page.getByRole("button", { name: "Sync tasks now" }).click();
    await expect(lastToast(page)).toContainText("Coda table is missing columns");
    await expect(lastToast(page)).toContainText("Status");

    const upsert = await (await request.get(`${CODA_STUB_URL}/last-upsert`)).json();
    expect(upsert.requestCount).toBe(0);
  });
});

test.describe("GitLab", () => {
  async function configureGitlab(page: Page, host: string, token: string) {
    await openIntegration(page, /^GitLab/);
    await page.getByLabel("Host").fill(host);
    if (token) await page.getByLabel("Access token").fill(token);
    const saved = page.waitForResponse(
      (r) => r.url().endsWith(`/api/projects/${PROJECT_KEY}`) && r.request().method() === "PUT"
    );
    await saveButton(page).click();
    await saved;
  }

  test("clears the stored token when the host changes without a replacement", async ({ page }) => {
    await signIn(page);
    await configureGitlab(page, "https://gitlab.example.com", "glpat-original");
    await expect(page.getByLabel("Access token")).toHaveAttribute(
      "placeholder",
      "Set — enter a new token to replace"
    );

    // The warning is a pure read of the draft, before any save
    await page.getByLabel("Host").fill("https://gitlab.other.example.com");
    await expect(
      page.getByText("The stored token was issued for the old host.")
    ).toBeVisible();

    const saved = page.waitForResponse(
      (r) => r.url().endsWith(`/api/projects/${PROJECT_KEY}`) && r.request().method() === "PUT"
    );
    await saveButton(page).click();
    await saved;

    await expect(page.getByLabel("Access token")).toHaveAttribute(
      "placeholder",
      "glpat-... (needs read_api scope)"
    );
    const stored = await storedProject();
    expect(stored.gitlabTokenSet).toBeFalsy();
  });

  test("Disconnect resets the host to default and clears the token", async ({ page }) => {
    await signIn(page);
    await configureGitlab(page, "https://gitlab.example.com", "glpat-original");

    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByLabel("Host")).toHaveValue("https://gitlab.com");
    const stored = await storedProject();
    expect(stored.gitlabHost).toBe("https://gitlab.com");
    expect(stored.gitlabTokenSet).toBeFalsy();
  });
});

test.describe("a refused sync", () => {
  test("is shown as a toast naming the failure, and the button returns to its normal label", async ({
    page,
    request,
  }) => {
    // Left unregistered: the stub's default `repository` is "example/board", so every request this
    // project's own owner/repo makes is answered 404 — a realistic upstream refusal with no new
    // stub behaviour needed.
    await request.post(`${GITHUB_STUB_URL}/reset`);
    await signIn(page);
    await page.goto(SETTINGS);
    await page.getByLabel("Repository URL").fill("https://github.com/e2e/unregistered-repo");
    const repoSaved = page.waitForResponse(
      (r) => r.url().endsWith(`/api/projects/${PROJECT_KEY}`) && r.request().method() === "PUT"
    );
    await saveButton(page).click();
    await repoSaved;

    await openIntegration(page, /^GitHub/);
    await page.getByLabel("Access token").fill("ghp_e2e");
    const tokenSaved = page.waitForResponse(
      (r) => r.url().endsWith(`/api/projects/${PROJECT_KEY}`) && r.request().method() === "PUT"
    );
    await saveButton(page).click();
    await tokenSaved;

    const syncButton = page.getByRole("button", { name: "Sync pull requests now" });
    await syncButton.click();
    await expect(lastToast(page)).toContainText("GitHub could not be reached");

    // The button state: not stuck on "Syncing...", the real observable a person has past the toast
    await expect(syncButton).toHaveText("Sync pull requests now");
    await expect(syncButton).toBeEnabled();
  });
});

test.describe("the Connections picker", () => {
  test("an integration opened from the picker can be removed again before it is configured", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(SETTINGS);

    const picker = page.getByRole("button", { name: /Add integration/ });
    if (await picker.isVisible()) await picker.click();
    await page.getByRole("button", { name: /^Webhooks/ }).first().click();

    // The tile click both opens and expands the row in one action (Connections.tsx), so it reads
    // "Collapse" already — asserting "Configure" here would be asserting the state before a click
    // that never has to happen
    await expect(page.getByRole("button", { name: "Collapse Webhooks" })).toBeVisible();
    await page.getByRole("button", { name: "Remove Webhooks" }).click();

    // Gone from the connected list specifically — not the catalogue tile, which shares the same
    // "Webhooks…" prefix and is expected to still exist (that's what "back in the catalogue" means)
    await expect(page.getByRole("button", { name: "Collapse Webhooks" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove Webhooks" })).toHaveCount(0);
    const reopened = page.getByRole("button", { name: /Add integration/ });
    if (await reopened.isVisible()) await reopened.click();
    await expect(page.getByRole("button", { name: /^Webhooks/ })).toBeVisible();
  });
});
