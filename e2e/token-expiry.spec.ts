import { test, expect, type Page } from "@playwright/test";
import mongoose from "mongoose";
import { GITLAB_STUB_URL } from "../playwright.config";
import { E2E_MONGODB_URI, OWNER_ID, PROJECT_ID, PROJECT_KEY, PROJECT_NAME, seed, seedRepository } from "./seed";
import { signIn } from "./session";

/**
 * BP-1109. A token that expires was only visible to whoever opened Settings → Integrations in its
 * last week, and a GitLab token was stored without GitLab ever being asked about it. The expiry
 * notice runs on its own tick, TOKEN_EXPIRY_TICK_MS=1500 for the suite, so these wait for it rather
 * than calling it.
 */

const SETTINGS = `/projects/${PROJECT_KEY}/settings?section=integrations`;
const lastToast = (page: Page) => page.getByTestId("toast").last();

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  return mongoose.connection.db!;
}

async function noticesFor(recipient: unknown) {
  return (await db()).collection("notifications").find({ recipient, type: "token_expiring" }).toArray();
}

test.beforeEach(seed);
test.afterAll(async () => {
  await mongoose.disconnect();
});

test("a board's owner is told once that its GitHub token expires, and the notice leads to the token", async ({ page }) => {
  await seedRepository({ repositoryUrl: "https://github.com/e2e-org/expiring", githubToken: "github_pat_e2e_expiring" });
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  await (await db()).collection("projects").updateOne({ _id: PROJECT_ID }, { $set: { githubConnection: { login: "octo", expiresAt, rejectedAt: null } } });

  await expect.poll(async () => (await noticesFor(OWNER_ID)).length, { timeout: 20_000 }).toBe(1);

  await signIn(page, "owner");
  await page.goto("/notifications");
  const notice = page.getByText(`The GitHub token of ${PROJECT_NAME} expires on`);
  await expect(notice).toBeVisible();
  await notice.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}/settings\\?section=integrations$`));

  // Several more ticks have run by now; the claim on this expiry keeps it at one
  await page.waitForTimeout(4_000);
  expect(await noticesFor(OWNER_ID)).toHaveLength(1);
});

test("a token already rejected, or a week and more away, is announced to nobody", async () => {
  await seedRepository({ repositoryUrl: "https://github.com/e2e-org/expiring", githubToken: "github_pat_e2e_expiring" });
  const projects = (await db()).collection("projects");
  await projects.updateOne(
    { _id: PROJECT_ID },
    { $set: { githubConnection: { expiresAt: new Date(Date.now() + 3 * 86_400_000), rejectedAt: new Date() } } }
  );
  // The control: a GitLab token on the same board, far from its expiry
  await projects.updateOne(
    { _id: PROJECT_ID },
    { $set: { gitlabToken: "enc:v3:not-read", gitlabConnection: { expiresAt: new Date(Date.now() + 30 * 86_400_000), rejectedAt: null } } }
  );

  await new Promise((resolve) => setTimeout(resolve, 4_000));
  expect(await noticesFor(OWNER_ID)).toHaveLength(0);
});

test.describe("a GitLab token is checked before it is stored", () => {
  test.beforeEach(async ({ request }) => {
    await request.post(`${GITLAB_STUB_URL}/control`, { data: { token: "glpat-e2e", username: "gl-owner", expiresAt: "2099-01-24" } });
  });

  async function saveGitlab(page: Page, token: string) {
    await page.goto(SETTINGS);
    const picker = page.getByRole("button", { name: /Add integration/ });
    const row = page.getByRole("button", { name: /^GitLab/ });
    await expect(picker.or(row).first()).toBeVisible();
    await expect(async () => {
      if (!(await row.first().isVisible())) await picker.click();
      await row.first().click();
      await expect(page.getByLabel("Host")).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await page.getByLabel("Host").fill(GITLAB_STUB_URL);
    await page.getByLabel("Access token").fill(token);
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${PROJECT_KEY}`) && r.request().method() === "PUT");
    await page.getByRole("button", { name: "Save changes" }).click();
    return saved;
  }

  test("a token GitLab refuses is not stored", async ({ page }) => {
    await signIn(page);
    expect((await saveGitlab(page, "glpat-wrong")).status()).toBe(400);

    await expect(lastToast(page)).toContainText("GitLab rejected this token: it is wrong, expired or revoked. Nothing was saved.");
    const project = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
    expect(project?.gitlabToken ?? "").toBe("");
  });

  test("a token GitLab takes is stored with whose it is and when it expires", async ({ page }) => {
    await signIn(page);
    expect((await saveGitlab(page, "glpat-e2e")).status()).toBe(200);

    await expect(page.getByRole("status").filter({ hasText: "Token of" })).toContainText("Token of gl-owner, expires 24 Jan 2099.");
    const project = await (await db()).collection("projects").findOne({ _id: PROJECT_ID });
    expect(project?.gitlabConnection).toMatchObject({ login: "gl-owner", expiresAt: new Date("2099-01-24T00:00:00Z") });
  });
});
