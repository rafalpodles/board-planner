import { test, expect, type Page } from "@playwright/test";
import { MEMBER_USERNAME, PROJECT_KEY, seed, seedCrew } from "./seed";
import { signIn, signInContext } from "./session";

/**
 * BP-199: the new-project wizard. One pass through it makes the board the person saw on Review,
 * with its workflow, starting fields and people, in one request; a refused create leaves nothing.
 *
 * Give this run its own database and port block; the fixture empties whatever it is pointed at:
 *   E2E_PORT=31990 E2E_MONGODB_URI=mongodb://localhost:27199/bp199_e2e npx playwright test e2e/new-project-wizard.spec.ts
 */

const NAME = "Zeppelin Works";
const KEY = "ZW";

test.beforeEach(async () => {
  await seed();
});

const heading = (page: Page, title: string) =>
  page.getByRole("heading", { level: 2, name: title });

/** Typing the name suggests the key, which only happens once React has hydrated; a fill() before it is dropped */
async function nameTheProject(page: Page, name: string, expectedKey: string) {
  const field = page.getByLabel("Project Name");
  await expect(async () => {
    await field.fill(name);
    await expect(page.getByLabel("Project Key")).toHaveValue(expectedKey, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

test("creates the board that Review showed, with its workflow, fields and people", async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page.goto("/projects/new");
  await expect(heading(page, "Basics")).toBeVisible();
  await nameTheProject(page, NAME, KEY);
  await page.getByLabel("Description").fill("Airships, on a schedule.");

  await page.getByRole("button", { name: /^Next: Workflow/ }).click();
  await expect(heading(page, "Workflow")).toBeVisible();
  await page.locator("label", { hasText: /^Simple/ }).click();
  await expect(page.getByRole("radio", { name: /^Simple/ })).toBeChecked();
  // The role table follows the choice: Simple has no review column, and says so
  const review = page.getByText("Awaiting review").locator("xpath=ancestor::div[1]");
  await expect(review).toContainText("No column");

  await page.getByRole("button", { name: /^Next: Task fields/ }).click();
  await expect(heading(page, "Task fields")).toBeVisible();
  await page
    .getByRole("group", { name: "Components to start with" })
    .getByRole("button", { name: "Add a few" })
    .click();
  const component = page.getByLabel("New component");
  await component.fill("airframe");
  await component.press("Enter");
  await component.fill("envelope");
  await component.press("Enter");
  await expect(page.getByRole("button", { name: "Remove airframe" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove envelope" })).toBeVisible();

  await page.getByRole("button", { name: /^Next: Automation/ }).click();
  await expect(heading(page, "Automation & access")).toBeVisible();
  const search = page.getByRole("combobox");
  await search.fill("E2E Mem");
  await page.getByRole("option", { name: /E2E Member/ }).click();
  await page.getByLabel(`Access for ${MEMBER_USERNAME}`).selectOption("owner");

  await page.getByRole("button", { name: /^Next: Review/ }).click();
  await expect(heading(page, "Review")).toBeVisible();
  await expect(page.getByText("Simple · 4 columns")).toBeVisible();
  await expect(page.getByText("airframe, envelope")).toBeVisible();
  await expect(page.getByText("E2E Member (owner)")).toBeVisible();

  const created = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/projects" && r.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Create Project" }).click();
  expect((await created).status()).toBe(201);
  await expect(page).toHaveURL(new RegExp(`/projects/${KEY}$`));

  // What was chosen on Review is what settings shows: the preset's columns, none of the default
  // ones it replaced, and the person who was added
  await page.goto(`/projects/${KEY}/settings?section=board`);
  const columnNames = page.getByLabel("Column name");
  await expect(columnNames).toHaveCount(4);
  expect(await columnNames.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))).toEqual([
    "Backlog",
    "To Do",
    "In Progress",
    "Done",
  ]);
  await page.goto(`/projects/${KEY}/settings?section=general`);
  await expect(page.getByLabel("Project name")).toHaveValue(NAME);
  await expect(page.getByLabel(`Access for ${MEMBER_USERNAME}`)).toHaveValue("owner");

  // And the person who was added can open it, which nobody else without a grant could
  const memberContext = await browser.newContext();
  await signInContext(memberContext, "member");
  const memberPage = await memberContext.newPage();
  await memberPage.goto(`/projects/${KEY}`);
  await expect(memberPage.getByRole("heading", { level: 1, name: NAME })).toBeVisible();
  await memberContext.close();

  // Read back what the screens above do not show: the starting component options
  const stored = await page.request.get(`/api/projects/${KEY}`);
  const body = (await stored.json()) as {
    customFields: { name: string; options: { value: string }[] }[];
    categories: { name: string }[];
  };
  expect(body.customFields.find((f) => f.name === "Component")?.options.map((o) => o.value)).toEqual([
    "airframe",
    "envelope",
  ]);
  expect(body.categories.map((c) => c.name)).toEqual(["bug", "doc", "user-story", "idea"]);
});

test("a board nobody was added to stays closed to the person who was not", async ({ page, browser }) => {
  await signIn(page);
  await page.goto("/projects/new");
  await nameTheProject(page, NAME, KEY);
  await page.getByRole("button", { name: /^Next: Workflow/ }).click();
  for (const title of ["Task fields", "Automation & access", "Review"]) {
    await page.getByRole("button", { name: "Skip" }).click();
    await expect(heading(page, title)).toBeVisible();
  }
  const created = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/projects" && r.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Create Project" }).click();
  expect((await created).status()).toBe(201);
  await expect(page).toHaveURL(new RegExp(`/projects/${KEY}$`));

  // Straight through the wizard is the old form's project: the seven default columns
  await page.goto(`/projects/${KEY}/settings?section=board`);
  await expect(page.getByLabel("Column name")).toHaveCount(7);

  // The control for the test above: with no grant, the same person is not let in
  const memberContext = await browser.newContext();
  await signInContext(memberContext, "member");
  const memberPage = await memberContext.newPage();
  await memberPage.goto("/projects");
  await expect(memberPage.locator(`main a[href="/projects/${PROJECT_KEY}"]`)).toBeVisible();
  await expect(memberPage.locator(`main a[href="/projects/${KEY}"]`)).toHaveCount(0);
  await memberContext.close();
});

test("a person is found by typing, ten at most, and never the caller", async ({ page }) => {
  await seedCrew();
  await signIn(page);
  await page.goto("/projects/new");
  await nameTheProject(page, NAME, KEY);
  await page.getByRole("button", { name: /^Next: Workflow/ }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(heading(page, "Automation & access")).toBeVisible();

  const search = page.getByRole("combobox");
  const asked: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/projects/setup/people") asked.push(r.url());
  });

  // One letter asks nothing
  await search.fill("c");
  await page.waitForTimeout(500);
  expect(asked).toHaveLength(0);

  // Fourteen people match; ten come back, and the list says to keep typing
  await search.fill("crew");
  await expect(page.getByRole("option")).toHaveCount(10);
  await expect(page.getByText("Showing the first 10. Keep typing to narrow the list.")).toBeVisible();

  // Typing more narrows it to the one person
  await search.fill("crew-13");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option", { name: /Crew Member 13/ })).toBeVisible();

  // The caller is never offered to themselves
  await search.fill("E2E Admin");
  await expect(page.getByText("No matches")).toBeVisible();
});

test("on a phone it is one step per screen and nothing is covered", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/projects/new");
  await nameTheProject(page, NAME, KEY);

  await expect(page.getByText("Step 1 of 5", { exact: true })).toBeVisible();
  const next = page.getByRole("button", { name: /^Next: Workflow/ });
  await expect(next).toBeVisible();

  // The PM launcher sits in the same corner; the bar raises it, so the button's centre is the
  // button's own and not the launcher's
  const covered = await next.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(hit === el || el.contains(hit));
  });
  expect(covered).toBe(false);

  await next.click();
  await expect(page.getByText("Step 2 of 5", { exact: true })).toBeVisible();
  await page.locator("label", { hasText: /^Custom/ }).click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
