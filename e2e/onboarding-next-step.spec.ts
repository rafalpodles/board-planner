import { test, expect, type Page } from "@playwright/test";
import {
  MEMBER_USERNAME,
  OUTSIDER_ID,
  OUTSIDER_PASSWORD,
  OUTSIDER_USERNAME,
  PROJECT_KEY,
  PROJECT_NAME,
  seed,
  seedAssignmentOutsider,
} from "./seed";
import { signIn, signInThroughForm } from "./session";
import { db, setGlobalCell } from "./notification-grid";

/**
 * BP-753: the places where the product said only that something was empty, and now says what to
 * do next. The member-with-no-board screen is pinned in projects-list.spec.ts beside the list it
 * replaces.
 */

const BOARD_ACCESS_ROW = "You are added to a board, or your role on one changes";

test.beforeEach(async () => {
  await seed();
  await seedAssignmentOutsider();
});

async function bellRow(page: Page, title: string) {
  await expect(async () => {
    await page.goto("/notifications");
    await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible({
      timeout: 3_000,
    });
  }).toPass({ timeout: 30_000 });
  return page.getByRole("link", { name: new RegExp(title) });
}

test("a new account is offered a board from the toast, and its owner hears about it", async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "New User" }).click();
  const form = page.getByRole("dialog", { name: "New User" });
  await form.getByLabel("Username").fill("grace");
  await form.getByLabel("Full Name").fill("Grace Hopper");
  await form.getByLabel("Password").fill("hopper-1906");
  const created = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/users" && r.request().method() === "POST"
  );
  await form.getByRole("button", { name: "Create User" }).click();
  expect((await created).status()).toBe(201);

  const toast = page.getByTestId("toast").filter({ hasText: "Grace Hopper's account is ready" });
  await expect(toast).toHaveText(
    "Grace Hopper's account is ready. They will see no board until you add them to one.Add to a board"
  );
  await toast.getByRole("button", { name: "Add to a board" }).click();

  const picker = page.getByRole("dialog", { name: "Add Grace Hopper to a board" });
  await picker.getByLabel("Board").selectOption({ label: `${PROJECT_NAME} (${PROJECT_KEY})` });
  await picker.getByLabel("Role").selectOption("member");
  const granted = page.waitForResponse(
    (r) =>
      /^\/api\/projects\/[^/]+\/members$/.test(new URL(r.url()).pathname) &&
      r.request().method() === "PUT"
  );
  await picker.getByRole("button", { name: "Add to board" }).click();
  expect((await granted).status()).toBe(200);
  await expect(picker).toHaveCount(0);
  await expect(
    page.getByTestId("toast").filter({ hasText: `Grace Hopper is now a member of ${PROJECT_NAME}` })
  ).toBeVisible();

  const grace = await (await browser.newContext()).newPage();
  await signInThroughForm(grace, "grace", "hopper-1906");
  await expect(grace.locator(`main a[href="/projects/${PROJECT_KEY}"]`)).toBeVisible();
  await expect(grace.getByTestId("not-on-any-board")).toHaveCount(0);

  const row = await bellRow(grace, `E2E Admin added you to ${PROJECT_NAME} as a member`);
  await expect(row).toContainText("Board access");
  await row.click();
  await expect(grace).toHaveURL(new RegExp(`/projects/${PROJECT_KEY}$`));
});

test("a role change on the board's settings reaches the person's bell", async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=general`);
  const access = page.getByLabel(`Access for ${MEMBER_USERNAME}`);
  await expect(access).toHaveValue("member");
  const changed = page.waitForResponse(
    (r) =>
      /^\/api\/projects\/[^/]+\/members$/.test(new URL(r.url()).pathname) &&
      r.request().method() === "PUT"
  );
  await access.selectOption("owner");
  expect((await changed).status()).toBe(200);

  const member = await (await browser.newContext()).newPage();
  await signIn(member, "member");
  await bellRow(member, `E2E Admin made you an owner of ${PROJECT_NAME}`);
});

test("somebody who unticked the row is not rung, though the event is recorded", async ({
  page,
  browser,
}) => {
  const outsider = await (await browser.newContext()).newPage();
  await signInThroughForm(outsider, OUTSIDER_USERNAME, OUTSIDER_PASSWORD);
  await expect(outsider.getByTestId("not-on-any-board")).toBeVisible();
  await setGlobalCell(outsider, BOARD_ACCESS_ROW, "In app", false);

  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=general`);
  await page.getByLabel("Add person").fill("outsider");
  const granted = page.waitForResponse(
    (r) =>
      /^\/api\/projects\/[^/]+\/members$/.test(new URL(r.url()).pathname) &&
      r.request().method() === "PUT"
  );
  await page.getByRole("button", { name: "E2E Outsider" }).click();
  expect((await granted).status()).toBe(200);

  // The dispatch is fire-and-forget; the stored row is the signal it has run, and it is stored
  // hidden rather than skipped because the digest reads the same documents
  const handle = await db();
  await expect
    .poll(
      async () =>
        (
          await handle
            .collection("notifications")
            .findOne({ recipient: OUTSIDER_ID, type: "board_access" })
        )?.inApp,
      { timeout: 15_000 }
    )
    .toBe(false);

  await outsider.goto("/notifications");
  await expect(outsider.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await expect(outsider.getByText(`added you to ${PROJECT_NAME}`)).toHaveCount(0);
  // The control: the grant itself landed, so the silence is the preference and not a failed add
  await outsider.goto("/projects");
  await expect(outsider.locator(`main a[href="/projects/${PROJECT_KEY}"]`)).toBeVisible();
});

test("the new-board form suggests a key from the name and says it is permanent", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/projects/new");
  const name = page.getByLabel("Project Name");
  const key = page.getByLabel("Project Key");

  await expect(async () => {
    await name.fill("Orbit Launch");
    await expect(key).toHaveValue("OL", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator("#project-key-hint")).toHaveText(
    "Task keys are built from it (OL-1, OL-2…) and it cannot change later."
  );

  await key.fill("sat");
  await expect(key).toHaveValue("SAT");
  await name.fill("Orbit Launch Control");
  await expect(key).toHaveValue("SAT");
  await expect(page.locator("#project-key-hint")).toContainText("(SAT-1, SAT-2…)");

  const created = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/projects" && r.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Create Project" }).click();
  expect((await created).status()).toBe(201);
  await expect(page).toHaveURL(/\/projects\/SAT$/);
});
