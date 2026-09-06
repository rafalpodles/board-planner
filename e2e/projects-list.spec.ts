import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  MEMBER_PASSWORD,
  MEMBER_USERNAME,
  NEWEST_PROJECT_DESCRIPTION,
  NEWEST_PROJECT_ICON,
  NEWEST_PROJECT_KEY,
  NEWEST_PROJECT_NAME,
  OUTSIDER_PASSWORD,
  OUTSIDER_USERNAME,
  PROJECT_ID,
  PROJECT_KEY,
  PROJECT_NAME,
  SECOND_PROJECT_ID,
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
  // Scoped to main: the sidebar links to the same boards on every route
  return page.locator('main a[href^="/projects/"]');
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
      await expect(newest).toContainText(NEWEST_PROJECT_KEY);
      await expect(newest).toContainText(NEWEST_PROJECT_DESCRIPTION);
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

    const newProject = page.getByRole("link", { name: "New Project" });
    await newProject.click();
    await expect(page).toHaveURL("/projects/new");
    await expect(page.getByRole("heading", { name: "New project" })).toBeVisible();

    await openProjects(page, "member");
    await expect(page.getByRole("link", { name: "New Project" })).toHaveCount(0);
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

/**
 * The two below assert what the product does today and name the tickets that say it should not,
 * so each turns red on the day it is fixed. Neither is `test.fail`-marked: that would make any
 * failure a pass.
 */

// TODO(BP-526): /projects/new is admin-only on the server and gated nowhere on the client
test("a member reaches the create-a-board form, and is refused only after filling it in", async ({
  page,
}) => {
  await signIn(page, "member");
  await page.goto("/projects/new");

  // Every other admin-only page redirects to /projects and renders nothing
  await expect(page).toHaveURL("/projects/new");
  await expect(page.getByRole("heading", { name: "New project" })).toBeVisible();

  await page.getByLabel("Project Name").fill("A board they may not create");
  await page.getByLabel("Project Key").fill("NOPE");
  const refused = page.waitForResponse(
    (response) => response.url().endsWith("/api/projects") && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Create Project" }).click();
  expect((await refused).status()).toBe(403);

  // The refusal a person actually reads, after typing a name, a key and a description
  await expect(page.getByText(/forbidden|admin/i)).toBeVisible();
  await expect(page).toHaveURL("/projects/new");
});

// TODO(BP-527): the key field stops at 5 characters, the rule it is validated against allows 20
test("the create form refuses a key the product accepts", async ({ page }) => {
  await signIn(page);
  await page.goto("/projects/new");

  const key = page.getByLabel("Project Key");
  await key.fill("LONGERKEY");
  await expect(key).toHaveValue("LONGE");
  await expect(key).toHaveAttribute("maxlength", "5");
});
