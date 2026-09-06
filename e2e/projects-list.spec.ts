import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  NEWEST_PROJECT_DESCRIPTION,
  NEWEST_PROJECT_ICON,
  NEWEST_PROJECT_KEY,
  NEWEST_PROJECT_NAME,
  OUTSIDER_PASSWORD,
  OUTSIDER_USERNAME,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  SECOND_PROJECT_KEY,
  SECOND_PROJECT_NAME,
  deleteProjectRow,
  seed,
  seedAssignmentOutsider,
  seedNewestProject,
  seedSecondProject,
} from "./seed";
import { signIn, signInThroughForm } from "./session";

test.beforeEach(seed);

function cards(page: Page): Locator {
  return page.locator('main a[href^="/projects/"]:not([href="/projects/new"])');
}

function card(page: Page, projectKey: string): Locator {
  return page.locator(`main a[href="/projects/${projectKey}"]`);
}

async function keysOnScreen(page: Page): Promise<string[]> {
  return (
    await cards(page).evaluateAll((links) =>
      links.map((link) => (link as HTMLAnchorElement).getAttribute("href") ?? "")
    )
  ).map((href) => href.split("/")[2]);
}

async function openProjects(page: Page, who: "admin" | "member" = "admin") {
  await signIn(page, who);
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
}

test.describe("the boards a reader may reach", () => {
  test.beforeEach(async () => {
    await seedSecondProject();
    await seedNewestProject();
  });

  test("one card per board, in the sidebar's order", async ({ page }) => {
    await openProjects(page);

    await expect(page.getByText("3 projects", { exact: true })).toBeVisible();

    await expect(keysOnScreen(page)).resolves.toEqual([
      NEWEST_PROJECT_KEY,
      PROJECT_KEY,
      SECOND_PROJECT_KEY,
    ]);

    await test.step("a card carries the board's name, key, icon and description", async () => {
      const newest = card(page, NEWEST_PROJECT_KEY);
      await expect(newest).toContainText(NEWEST_PROJECT_NAME);
      await expect(newest.locator("span.font-mono")).toHaveText(NEWEST_PROJECT_KEY);
      await expect(newest.locator("p")).toHaveText(NEWEST_PROJECT_DESCRIPTION);
      await expect(newest.getByText(NEWEST_PROJECT_ICON)).toBeVisible();

      const bare = card(page, SECOND_PROJECT_KEY);
      await expect(bare).toContainText(SECOND_PROJECT_NAME);
      await expect(bare.locator("p")).toHaveCount(0);
      await expect(bare.getByText("📋")).toBeVisible();
    });
  });

  test("a card opens its board", async ({ page }) => {
    await openProjects(page);

    await card(page, PROJECT_KEY).click();
    await expect(page).toHaveURL(`/projects/${PROJECT_KEY}`);
    await expect(page.getByRole("heading", { name: PROJECT_NAME })).toBeVisible();
  });

  test("a member is shown the board they hold, and not the two they do not", async ({ page }) => {
    await openProjects(page, "member");

    await expect(card(page, PROJECT_KEY)).toBeVisible();
    await expect(keysOnScreen(page)).resolves.toEqual([PROJECT_KEY]);
    await expect(page.getByText("1 project", { exact: true })).toBeVisible();

    const listed = await page.request.get("/api/projects");
    expect(listed.status()).toBe(200);
    const sent = JSON.stringify(await listed.json());
    expect(sent).toContain(PROJECT_NAME);
    expect(sent).not.toContain(SECOND_PROJECT_NAME);
    expect(sent).not.toContain(NEWEST_PROJECT_NAME);
  });

  test("New Project is the admin's, and the member is not offered it", async ({ page }) => {
    await openProjects(page);

    await expect(page.locator('aside a[href="/projects/new"]')).toHaveCount(1);

    await page.locator('main a[href="/projects/new"]').click();
    await expect(page).toHaveURL("/projects/new");
    await expect(page.getByRole("heading", { name: "New project" })).toBeVisible();

    await openProjects(page, "member");
    await expect(page.locator('main a[href="/projects/new"]')).toHaveCount(0);
    await expect(page.locator('aside a[href="/projects/new"]')).toHaveCount(0);
  });
});

test("with nothing to show, the list says so — and only an admin is offered a first board", async ({
  page,
}) => {
  await seedAssignmentOutsider();

  await test.step("an account with no grant anywhere", async () => {
    await signInThroughForm(page, OUTSIDER_USERNAME, OUTSIDER_PASSWORD);
    await expect(page.getByText("No projects yet")).toBeVisible();
    await expect(page.getByText("0 projects", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Create your first project/ })).toHaveCount(0);

    await expect(card(page, PROJECT_KEY)).toHaveCount(0);
  });

  await test.step("an admin on an instance with no boards at all", async () => {
    await deleteProjectRow(PROJECT_ID);
    await signIn(page);
    await page.goto("/projects");

    await expect(page.getByText("No projects yet")).toBeVisible();
    await expect(page.getByRole("link", { name: /Create your first project/ })).toBeVisible();
  });
});

test("a member typing the URL is bounced to /projects", async ({ page }) => {
  await signIn(page, "member");
  await page.goto("/projects/new");

  await expect(page).toHaveURL("/projects");
  await expect(page.getByRole("heading", { name: "New project" })).toHaveCount(0);
});

test("the create form accepts a key as long as the product allows", async ({ page }) => {
  await signIn(page);
  await page.goto("/projects/new");

  const key = page.getByLabel("Project Key");
  await key.fill("twentycharacterkeyxx");
  await expect(key).toHaveValue("TWENTYCHARACTERKEYXX");
  await expect(key).toHaveAttribute("maxlength", "20");

  await page.getByLabel("Project Name").fill("A key as long as the product allows");
  const created = page.waitForResponse(
    (response) => response.url().endsWith("/api/projects") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Create Project" }).click();
  expect((await created).status()).toBe(201);
  await expect(page).toHaveURL("/projects/TWENTYCHARACTERKEYXX");
});
