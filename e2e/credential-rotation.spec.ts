import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, PROJECT_NAME, seed } from "./seed";
import { signIn } from "./session";
import { McpSession, authorize } from "./mcp";

/**
 * BP-706. Credentials could be added in a test and never rotated or revoked: a webhook's URL
 * replaced, a webhook removed, an OAuth client deleted and a connected app revoked — each driven
 * through the screen that offers it, and each checked where it lives rather than on the row that
 * disappeared. A revoked OAuth credential is sent again after the click; the same request before
 * it is the control.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings?section=integrations`;

const ALPHA = { _id: new mongoose.Types.ObjectId(), url: "https://hooks.example.com/board/alpha" };
const BRAVO = { _id: new mongoose.Types.ObjectId(), url: "https://hooks.example.com/board/bravo" };
const ROTATED_URL = "https://hooks.example.com/board/rotated";
// maskSecretUrl keeps the origin and the last four characters, and the mask is each row's name
const ALPHA_ROW = "https://hooks.example.com/••••lpha";
const BRAVO_ROW = "https://hooks.example.com/••••ravo";

type StoredWebhook = { _id: mongoose.Types.ObjectId; url: string; enabled: boolean };

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

async function storedWebhooks(): Promise<StoredWebhook[]> {
  const project = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
  return (project?.webhooks ?? []) as StoredWebhook[];
}

async function seedTwoWebhooks() {
  const events = ["task_created", "status_changed"];
  await (await db()).collection("projects").updateOne(
    { _id: PROJECT_ID },
    {
      $set: {
        webhooks: [
          { ...ALPHA, events, enabled: true },
          { ...BRAVO, events, enabled: true },
        ],
      },
    }
  );
}

async function openWebhooks(page: Page, expectedRow = ALPHA_ROW) {
  await page.goto(SETTINGS);
  const picker = page.getByRole("button", { name: /Add integration/ });
  const webhooksRow = page.getByRole("button", { name: /Webhooks/ });
  await expect(picker.or(webhooksRow).first()).toBeVisible();
  const replace = page.getByRole("button", { name: `Replace URL for ${expectedRow}` });
  await expect(async () => {
    if (!(await replace.isVisible())) await webhooksRow.first().click();
    await expect(replace).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

const webhookWrite = (page: Page, method: string) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === method && new URL(r.url()).pathname.endsWith("/webhooks")
  );

const lastToast = (page: Page) => page.getByTestId("toast").last();

test.beforeEach(async () => {
  await seed();
});

test.afterAll(async () => {
  await mongoose.disconnect();
});

test.describe("webhooks", () => {
  test.beforeEach(seedTwoWebhooks);

  test("Replace is refused while other webhook edits are unsaved, then rotates the URL once they are gone", async ({
    page,
  }) => {
    await signIn(page);
    await openWebhooks(page);

    const writes: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/webhooks") && r.method() !== "GET") writes.push(r.method());
    });

    await page.getByRole("button", { name: `Enabled for ${BRAVO_ROW}` }).click();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();

    await page.getByRole("button", { name: `Replace URL for ${ALPHA_ROW}` }).click();
    const field = page.getByRole("textbox", { name: `URL for ${ALPHA_ROW}`, exact: true });
    await field.fill(ROTATED_URL);
    await page.getByRole("button", { name: `Save URL for ${ALPHA_ROW}` }).click();

    await expect(lastToast(page)).toHaveText(
      "Save or discard your webhook changes before replacing a URL"
    );
    await expect(field, "a refused replace keeps what was typed").toHaveValue(ROTATED_URL);
    await page.waitForTimeout(1_000);
    expect(writes, "the refusal must not reach the server").toEqual([]);
    expect((await storedWebhooks()).map((w) => w.url)).toEqual([ALPHA.url, BRAVO.url]);

    await page.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();

    const replaced = webhookWrite(page, "PUT");
    await page.getByRole("button", { name: `Save URL for ${ALPHA_ROW}` }).click();
    expect((await replaced).status()).toBe(200);
    await expect(lastToast(page)).toHaveText("Webhook URL replaced");

    const stored = await storedWebhooks();
    expect(stored.map((w) => String(w._id))).toEqual([String(ALPHA._id), String(BRAVO._id)]);
    expect(stored[0].url).toBe(ROTATED_URL);
    // The discarded toggle stayed discarded, and the neighbour kept its own URL
    expect(stored[1]).toMatchObject({ url: BRAVO.url, enabled: true });
    await expect(page.getByText("https://hooks.example.com/••••ated")).toBeVisible();
  });

  test("Delete then Save removes that webhook from the stored project and leaves the other", async ({
    page,
  }) => {
    await signIn(page);
    await openWebhooks(page);

    await page.getByRole("button", { name: `Delete ${ALPHA_ROW}` }).click();
    const removed = webhookWrite(page, "DELETE");
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await removed).status()).toBe(200);

    const stored = await storedWebhooks();
    expect(stored.map((w) => String(w._id))).toEqual([String(BRAVO._id)]);
    expect(stored.map((w) => w.url)).toEqual([BRAVO.url]);

    await openWebhooks(page, BRAVO_ROW);
    await expect(page.getByRole("button", { name: `Replace URL for ${ALPHA_ROW}` })).toHaveCount(0);
  });
});

test.describe("OAuth credentials", () => {
  const FIRST = "E2E Revoked Client";
  const SECOND = "E2E Surviving Client";

  async function connectApp(browser: Browser, baseURL: string | undefined, request: APIRequestContext, clientName: string) {
    // Its own context: the consent screen signs in through its form, once per authorization
    const context = await browser.newContext({ baseURL });
    try {
      return await authorize(await context.newPage(), request, { clientName });
    } finally {
      await context.close();
    }
  }

  async function expectWorks(request: APIRequestContext, accessToken: string) {
    const res = await request.get(`/api/projects/${PROJECT_KEY}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).name).toBe(PROJECT_NAME);
    const { status } = await new McpSession(request, accessToken).call("tools/list");
    expect(status).toBe(200);
  }

  async function expectDead(request: APIRequestContext, issued: { accessToken: string; refreshToken: string; clientId: string }) {
    const board = await request.get(`/api/projects/${PROJECT_KEY}`, {
      headers: { Authorization: `Bearer ${issued.accessToken}` },
    });
    expect(board.status()).toBe(401);
    const { status } = await new McpSession(request, issued.accessToken).call("tools/list");
    expect(status).toBe(401);
    expect(issued.refreshToken).toMatch(/^cprt_./);
    const refreshed = await request.post("/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: issued.refreshToken, client_id: issued.clientId },
    });
    expect(refreshed.status()).toBe(400);
    expect((await refreshed.json()).error).toBe("invalid_grant");
  }

  async function expectRefreshes(request: APIRequestContext, issued: { refreshToken: string; clientId: string }) {
    expect(issued.refreshToken).toMatch(/^cprt_./);
    const refreshed = await request.post("/oauth/token", {
      form: { grant_type: "refresh_token", refresh_token: issued.refreshToken, client_id: issued.clientId },
    });
    expect(refreshed.status(), await refreshed.text()).toBe(200);
  }

  async function openTokens(page: Page) {
    await signIn(page);
    await page.goto("/settings/tokens");
    await page.waitForLoadState("networkidle");
  }

  const section = (page: Page, heading: string) =>
    page.locator("div.mt-8").filter({ has: page.getByRole("heading", { name: heading }) });
  const row = (page: Page, heading: string, name: string) =>
    section(page, heading).locator("div.rounded-lg").filter({ hasText: name });

  test("revoking one connected app kills its token and leaves the other working", async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const revoked = await connectApp(browser, baseURL, request, FIRST);
    const survivor = await connectApp(browser, baseURL, request, SECOND);
    await expectWorks(request, revoked.accessToken);
    await expectWorks(request, survivor.accessToken);

    await openTokens(page);
    const connections = section(page, "Connected apps (OAuth)").getByRole("button", { name: "Revoke" });
    await expect(connections).toHaveCount(2);

    const deleted = page.waitForResponse(
      (r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === "/api/oauth/connections"
    );
    await row(page, "Connected apps (OAuth)", FIRST).getByRole("button", { name: "Revoke" }).click();
    expect((await deleted).status()).toBe(200);

    await expect(row(page, "Connected apps (OAuth)", FIRST)).toHaveCount(0);
    await expect(connections).toHaveCount(1);
    await expect(row(page, "Connected apps (OAuth)", SECOND)).toBeVisible();

    await expectDead(request, revoked);
    await expectWorks(request, survivor.accessToken);
    await expectRefreshes(request, survivor);

    await page.reload();
    await expect(row(page, "Connected apps (OAuth)", SECOND)).toBeVisible();
    await expect(connections).toHaveCount(1);
  });

  test("deleting one OAuth client revokes what it was issued and leaves the other client working", async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const revoked = await connectApp(browser, baseURL, request, FIRST);
    const survivor = await connectApp(browser, baseURL, request, SECOND);
    await expectWorks(request, revoked.accessToken);
    await expectWorks(request, survivor.accessToken);

    await openTokens(page);
    const clients = section(page, "OAuth clients").getByRole("button", { name: "Delete" });
    await expect(clients).toHaveCount(2);

    const confirmed: string[] = [];
    page.once("dialog", (dialog) => {
      confirmed.push(dialog.message());
      void dialog.accept();
    });
    const deleted = page.waitForResponse(
      (r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === "/api/oauth/clients"
    );
    await row(page, "OAuth clients", FIRST).getByRole("button", { name: "Delete" }).click();
    expect((await deleted).status()).toBe(200);
    expect(confirmed).toEqual([expect.stringContaining(FIRST)]);

    await expect(row(page, "OAuth clients", FIRST)).toHaveCount(0);
    await expect(clients).toHaveCount(1);
    await expect(row(page, "Connected apps (OAuth)", FIRST)).toHaveCount(0);

    await expectDead(request, revoked);
    await expectWorks(request, survivor.accessToken);
    await expectRefreshes(request, survivor);

    await page.reload();
    await expect(row(page, "OAuth clients", SECOND)).toBeVisible();
    await expect(clients).toHaveCount(1);
    await expect(section(page, "Connected apps (OAuth)").getByRole("button", { name: "Revoke" })).toHaveCount(1);
  });

  // BP-747. issueTokens now checks the client still exists before handing back a fresh pair. The
  // race this closes is "the client's deletion cascade has already run by the time this insert
  // lands" — reproduced directly here rather than actually raced, because two real HTTP requests'
  // relative timing cannot be trusted to land in the one order that would exercise the new check
  // at all (test-quality review: a version of this test that fired a UI delete-click and a raw
  // refresh call together via Promise.all passed regardless of which one the fix removed — the
  // refresh almost always finished before the click's several round trips even started, so it was
  // proving only the pre-existing `deleteMany` cleanup, not the new `OAuthClient.exists` check).
  test("a refresh for a client that is already gone is refused, and leaves no orphaned token", async ({
    request,
    browser,
    baseURL,
  }) => {
    const RACER = "E2E Race Client";
    const racer = await connectApp(browser, baseURL, request, RACER);
    await expectWorks(request, racer.accessToken);
    // Not vacuous: there is a live row here before the delete below, so a null after it means the
    // delete actually ran — not that nothing was ever there (test-quality review).
    expect(
      await (await db()).collection("oauthtokens").findOne({ clientId: racer.clientId })
    ).not.toBeNull();

    // The state a client's deletion cascade leaves mid-flight if it dies right after removing the
    // client row: the client is gone, the token row this refresh is about to consume is not.
    const { deletedCount } = await (await db())
      .collection("oauthclients")
      .deleteOne({ clientId: racer.clientId });
    expect(deletedCount, "the setup must actually remove the client row").toBe(1);

    // Free coverage for the other half of the same fix (auth.ts's verifyOAuthAccessToken): the
    // still-live access token this same client issued is refused too, once the client is gone.
    const board = await request.get(`/api/projects/${PROJECT_KEY}`, {
      headers: { Authorization: `Bearer ${racer.accessToken}` },
    });
    expect(board.status()).toBe(401);

    const refreshed = await request.post("/oauth/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: racer.refreshToken,
        client_id: racer.clientId,
      },
    });

    expect(refreshed.status()).toBe(400);
    expect((await refreshed.json()).error).toBe("invalid_grant");
    const orphan = await (await db()).collection("oauthtokens").findOne({ clientId: racer.clientId });
    expect(orphan, "no live row survives — not the consumed old one, not a freshly minted one").toBeNull();
  });
});
