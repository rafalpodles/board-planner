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

/**
 * BP-469: `/projects`, the list every reader lands on.
 *
 * Until now the suite only ever navigated *through* this page — `goto("/projects")` as a way to
 * be somewhere — so nothing asserted that it lists anything at all. What it does that no other
 * screen does: it shows one card per board this reader may reach, in the order the sidebar uses,
 * and it is where the instance's one create-a-board affordance lives.
 *
 * The fixture is three boards so each claim has a counter-example: NB carries a description and an
 * icon where IB carries neither, the member holds a grant on TP alone, and NB is newest while
 * sharing TP's sortOrder — which is the only shape that tells the two sort keys apart.
 */

test.beforeEach(seed);

function cards(page: Page): Locator {
  // Scoped to main because the sidebar links to the same boards on every route, and past
  // /projects/new because the header's own action lives inside main too
  return page.locator('main a[href^="/projects/"]:not([href="/projects/new"])');
}

function card(page: Page, projectKey: string): Locator {
  return page.locator(`main a[href="/projects/${projectKey}"]`);
}

/** The keys, top-left to bottom-right — the grid renders in DOM order. */
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

    // sortOrder first, then newest-first among equals. NB shares TP's sortOrder and is newer, so
    // it leads; IB is newer than TP and comes last, which only a sort reading sortOrder produces
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

      // The control for the two halves that are conditional: this board has neither, and the card
      // falls back to the default icon rather than rendering an empty one
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

    // Not the page's own filtering: the boards it was never sent
    const listed = await page.request.get("/api/projects");
    expect(listed.status()).toBe(200);
    const sent = JSON.stringify(await listed.json());
    expect(sent).toContain(PROJECT_NAME);
    expect(sent).not.toContain(SECOND_PROJECT_NAME);
    expect(sent).not.toContain(NEWEST_PROJECT_NAME);
  });

  test("New Project is the admin's, and the member is not offered it", async ({ page }) => {
    await openProjects(page);

    // The control for the negative below: the sidebar's "+" does exist, for somebody. Located by
    // href inside the sidebar, because an accessible name matches case-insensitively and the
    // header's own "New Project" would answer to "New project" too
    await expect(page.locator('aside a[href="/projects/new"]')).toHaveCount(1);

    // In main, not the sidebar: the sidebar carries a second link to the same page, and the two
    // are gated separately
    await page.locator('main a[href="/projects/new"]').click();
    await expect(page).toHaveURL("/projects/new");
    await expect(page.getByRole("heading", { name: "New project" })).toBeVisible();

    await openProjects(page, "member");
    await expect(page.locator('main a[href="/projects/new"]')).toHaveCount(0);
    // The sidebar's "+" is the same gate on the same page, and is asserted nowhere else
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

    // The control: the board exists, and this reader is the reason it is not on screen
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

// BP-534: /projects/new used to read no auth state at all, so a member typing the URL got the
// full form and was only refused after filling it in and posting. It now gates itself the same
// way every other admin-only page does — redirect to /projects, render nothing.
test("a member typing the URL is bounced before the form — or a POST — is ever reached", async ({
  page,
}) => {
  const posted: string[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/api/projects") && req.method() === "POST") posted.push(req.url());
  });

  await signIn(page, "member");
  await page.goto("/projects/new");

  await expect(page).toHaveURL("/projects");
  await expect(page.getByRole("heading", { name: "New project" })).toHaveCount(0);
  expect(posted).toEqual([]);
});

// BP-535: the key field used to stop at 5 characters while the rule it is validated against
// allows 20, silently truncating a legitimate key. Driven through the real form, since the bug
// was in the client, not the server.
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
