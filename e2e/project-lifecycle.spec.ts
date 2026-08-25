import { test, expect, type Browser, type Page } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  OUTSIDER_FULL_NAME,
  OUTSIDER_PASSWORD,
  OUTSIDER_USERNAME,
  PROJECT_KEY,
  PROJECT_NAME,
  seed,
  seedAssignmentOutsider,
} from "./seed";
import { signIn as arriveSignedIn, signInThroughForm } from "./session";

/**
 * BP-388, the identity-and-access half: creating a board, renaming it, deleting it, and handing
 * out or taking back the right to open it. The board's own structure — columns, roles, categories
 * — is BP-412 and is deliberately absent here.
 *
 * Give this run its own database and port block; the fixture empties whatever it is pointed at:
 *   E2E_PORT=4050 E2E_MONGODB_URI=mongodb://localhost:27017/bp388_e2e npx playwright test …
 *
 * One product note the assertions below deliberately do not freeze: the sidebar's project list is
 * fetched once by its provider and never refetched, so creating, renaming or deleting a board
 * leaves the rail beside it stale until a reload. Every sidebar assertion here therefore reloads
 * first. Asserting the stale state as correct would cement it.
 *
 * Every destructive test operates on a board it created itself. The seeded TP board is what the
 * rest of the file stands on, and deleting it would surface as a product bug three tests later.
 */

const NEW_NAME = "Zeppelin Works";
const NEW_KEY = "ZW";
const SECOND_KEY = "ZX";

const signIn = (page: Page, username: string, password: string) =>
  username === ADMIN_USERNAME
    ? arriveSignedIn(page)
    : username === MEMBER_USERNAME
      ? arriveSignedIn(page, "member")
      : signInThroughForm(page, username, password);

const sidebarLink = (page: Page, name: string) =>
  page.getByRole("complementary").getByRole("link", { name: new RegExp(name) });

/**
 * The form uppercases the key as it is typed, so a lower-case value coming back upper-case is
 * proof that React is running here — a fill() landing before hydration is dropped, and
 * toHaveValue would still pass on Playwright's own write.
 */
async function openCreateForm(page: Page, key: string) {
  await page.goto("/projects/new");
  const keyInput = page.getByLabel("Project Key");
  await keyInput.fill(key.toLowerCase());
  await expect(keyInput).toHaveValue(key.toUpperCase());
}

async function submitCreate(page: Page) {
  const answered = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/projects" && r.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Create Project" }).click();
  return answered;
}

/** The settings screen fills its inputs from a client fetch, so a value here means it landed */
async function openSettings(page: Page, projectRef: string) {
  await page.goto(`/projects/${projectRef}/settings?section=general`);
  await expect(page.getByLabel("Project name")).not.toHaveValue("");
}

test.beforeEach(async () => {
  await seed();
  // Reused rather than seeded again: BP-400 already put an account with no grant anywhere into
  // this file, which is exactly the reader a grant handed out below has to change the answer for.
  // It brings a task assigned to that person along, which nothing here counts.
  await seedAssignmentOutsider();
});

test.describe("creating a board", () => {
  test("stores the key upper-case and lands on the new board", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await openCreateForm(page, NEW_KEY);
    await page.getByLabel("Project Name").fill(NEW_NAME);
    const response = await submitCreate(page);
    expect(response.status()).toBe(201);

    // The address is built from what the server stored, not from what was typed
    await expect(page).toHaveURL(new RegExp(`/projects/${NEW_KEY}$`));
    await expect(page.getByRole("heading", { name: new RegExp(NEW_NAME) })).toBeVisible();

    // Only after a reload: the sidebar's project list is fetched once and never asked again, so a
    // board created a second ago is not in the rail beside it yet. See the note at the foot.
    await page.reload();
    await expect(sidebarLink(page, NEW_NAME)).toBeVisible();
  });

  test("refuses a key another board already holds, and takes a free one after", async ({
    page,
  }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    await openCreateForm(page, PROJECT_KEY);
    await page.getByLabel("Project Name").fill("Second board on a taken key");
    const refused = await submitCreate(page);

    // Asserted on the status, not only on a message: an error paragraph appears for any failure,
    // and "the key is taken" has to be told apart from "the request fell over"
    expect(refused.ok()).toBe(false);
    await expect(page).toHaveURL(/\/projects\/new$/);
    await expect(sidebarLink(page, "Second board on a taken key")).toHaveCount(0);

    // The control, on the same form and the same submit path: a free key goes through
    const keyInput = page.getByLabel("Project Key");
    await keyInput.fill(SECOND_KEY.toLowerCase());
    await expect(keyInput).toHaveValue(SECOND_KEY);
    const accepted = await submitCreate(page);
    expect(accepted.status()).toBe(201);
    await expect(page).toHaveURL(new RegExp(`/projects/${SECOND_KEY}$`));
  });
});

test.describe("renaming a board", () => {
  test("the save bar is what changes the name, not the typing", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openSettings(page, PROJECT_KEY);

    await page.getByLabel("Project name").fill(NEW_NAME);
    // Nothing has been saved yet, so the rest of the app still says the old name. Without this the
    // assertion below would pass on a screen that merely echoes the keystrokes back.
    await expect(sidebarLink(page, PROJECT_NAME)).toBeVisible();

    const saved = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.startsWith("/api/projects/") && r.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    expect((await saved).status()).toBe(200);

    // Not asserted here: the sidebar still says the old name at this point. replaceProject only
    // touches this page's own state, and the projects provider behind the sidebar is never asked
    // to refetch — so the rename is stored but the rail beside it goes stale until a reload.
    // Filed rather than frozen into an expectation.
    await page.reload();
    await expect(sidebarLink(page, NEW_NAME)).toBeVisible();
    await expect(sidebarLink(page, PROJECT_NAME)).toHaveCount(0);
  });

  test("discarding puts the stored name back", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openSettings(page, PROJECT_KEY);

    await page.getByLabel("Project name").fill(NEW_NAME);
    await page.getByRole("button", { name: "Discard" }).click();

    await expect(page.getByLabel("Project name")).toHaveValue(PROJECT_NAME);
    await page.reload();
    await expect(sidebarLink(page, PROJECT_NAME)).toBeVisible();
  });

  test("the key cannot be changed once tasks are built from it", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openSettings(page, PROJECT_KEY);

    // A deliberate product decision, not an oversight, and now agreed on both sides: the PUT
    // endpoint stopped accepting `key` at all (BP-415 and the immutability fix before it), and
    // this field is disabled to match. Locked here so that turning it back on becomes a decision
    // somebody has to make on purpose, on both sides rather than one.
    await expect(page.getByLabel("Project key")).toBeDisabled();
    await expect(page.getByLabel("Project key")).toHaveValue(PROJECT_KEY);
    // The control: the card is live, and "disabled" is a property of this field alone
    await expect(page.getByLabel("Project name")).toBeEditable();
  });
});

test.describe("deleting a board", () => {
  async function createBoard(page: Page, name: string, key: string) {
    await openCreateForm(page, key);
    await page.getByLabel("Project Name").fill(name);
    expect((await submitCreate(page)).status()).toBe(201);
    await expect(page).toHaveURL(new RegExp(`/projects/${key}$`));
  }

  test("asks first, and cancelling leaves the board alone", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await createBoard(page, NEW_NAME, NEW_KEY);
    await openSettings(page, NEW_KEY);

    await page.getByRole("button", { name: "Delete project..." }).click();
    await expect(page.getByRole("dialog")).toContainText(`Delete "${NEW_NAME}"?`);
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByRole("dialog")).toBeHidden();
    await page.reload();
    await expect(sidebarLink(page, NEW_NAME)).toBeVisible();
  });

  test("confirming removes it, and its address stops resolving", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await createBoard(page, NEW_NAME, NEW_KEY);
    await openSettings(page, NEW_KEY);

    const deleted = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.startsWith("/api/projects/") && r.request().method() === "DELETE"
    );
    await page.getByRole("button", { name: "Delete project..." }).click();
    await page.getByRole("button", { name: "Delete project", exact: true }).click();
    expect((await deleted).status()).toBe(200);

    await expect(page).toHaveURL(/\/projects$/);

    // Same stale rail as on create: the deleted board is still listed until the list is fetched
    // again, so this is asserted after a reload rather than immediately
    await page.reload();
    await expect(sidebarLink(page, NEW_NAME)).toHaveCount(0);
    // The seeded board is untouched, so the absence above is this board being gone rather than
    // the sidebar failing to render
    await expect(sidebarLink(page, PROJECT_NAME)).toBeVisible();

    await page.goto(`/projects/${NEW_KEY}`);
    await expect(page.getByText("Failed to load this board.")).toBeVisible();
  });

  test("a member without owner rights is never offered the section it lives in", async ({
    page,
  }) => {
    await signIn(page, MEMBER_USERNAME, MEMBER_PASSWORD);
    await page.goto(`/projects/${PROJECT_KEY}/settings?section=general`);

    // The gate is coarser than the button: General is a projectAdmin section, so this reader is
    // told it exists and shown none of it — no identity fields, no members list, no danger zone.
    await expect(
      page.getByText("The rest of this project's settings need admin access.")
    ).toBeVisible();
    await expect(page.getByLabel("Project name")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete project..." })).toHaveCount(0);
  });

  test("and the admin, on the same screen, is", async ({ page }) => {
    await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
    await openSettings(page, PROJECT_KEY);

    await expect(page.getByRole("button", { name: "Delete project..." })).toBeVisible();
  });
});

test.describe("who can use this board", () => {
  async function addPerson(page: Page, fullName: string) {
    const found = page.waitForResponse((r) =>
      new URL(r.url()).pathname.endsWith("/members/candidates")
    );
    await page.getByLabel("Add person").fill(OUTSIDER_USERNAME);
    await found;
    const granted = page.waitForResponse(
      (r) => new URL(r.url()).pathname.endsWith("/members") && r.request().method() === "PUT"
    );
    await page.getByRole("button", { name: fullName }).click();
    expect((await granted).status()).toBe(200);
  }

  async function contextFor(browser: Browser, username: string, password: string) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, username, password);
    return { context, page };
  }

  test("a grant handed out here is what opens the board", async ({ browser }) => {
    const outsider = await contextFor(browser, OUTSIDER_USERNAME, OUTSIDER_PASSWORD);
    const admin = await contextFor(browser, ADMIN_USERNAME, ADMIN_PASSWORD);

    try {
      // Before: an account in good standing, with no grant on this board
      await outsider.page.goto(`/projects/${PROJECT_KEY}`);
      await expect(outsider.page.getByText("Failed to load this board.")).toBeVisible();

      await openSettings(admin.page, PROJECT_KEY);
      await addPerson(admin.page, OUTSIDER_FULL_NAME);
      await expect(admin.page.getByLabel(`Access for ${OUTSIDER_USERNAME}`)).toHaveValue("member");

      // After: the same address, the same person, a different answer
      await outsider.page.reload();
      await expect(outsider.page.getByText("Failed to load this board.")).toHaveCount(0);
      await expect(
        outsider.page.getByRole("heading", { name: new RegExp(PROJECT_NAME) })
      ).toBeVisible();
    } finally {
      await outsider.context.close();
      await admin.context.close();
    }
  });

  test("and taking it back closes the board again", async ({ browser }) => {
    const outsider = await contextFor(browser, OUTSIDER_USERNAME, OUTSIDER_PASSWORD);
    const admin = await contextFor(browser, ADMIN_USERNAME, ADMIN_PASSWORD);

    try {
      await openSettings(admin.page, PROJECT_KEY);
      await addPerson(admin.page, OUTSIDER_FULL_NAME);

      // The control: they really did have it, on this same board, a moment ago
      await outsider.page.goto(`/projects/${PROJECT_KEY}`);
      await expect(
        outsider.page.getByRole("heading", { name: new RegExp(PROJECT_NAME) })
      ).toBeVisible();

      const revoked = admin.page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname.endsWith("/members") && r.request().method() === "DELETE"
      );
      await admin.page
        .getByLabel(`Access for ${OUTSIDER_USERNAME}`)
        .selectOption("none");
      expect((await revoked).status()).toBe(200);

      await outsider.page.reload();
      await expect(outsider.page.getByText("Failed to load this board.")).toBeVisible();
    } finally {
      await outsider.context.close();
      await admin.context.close();
    }
  });
});
