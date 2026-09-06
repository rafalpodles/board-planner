import { test, expect, type Page } from "@playwright/test";
import { PROJECT_NAME, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-469: the screen a person gets when the app throws.
 *
 * `src/app/error.tsx` had never been rendered by a test, and what it rendered was the raw
 * `error.stack` — twelve frames of `_next/static/chunks/...` — on the surface, above the fold, to
 * whoever happened to be using the product. The decision recorded in BP-469 was to keep the stack
 * (it is what makes a report from a colleague actionable) and put it behind a disclosure with a
 * way to copy it, rather than delete it or show it by default.
 *
 * The crash is caused rather than simulated: `/api/projects` is answered with a shape the sidebar
 * cannot render. `useProjectsProvider` catches the *fetch* and not what the value does afterwards
 * (`src/hooks/use-projects.ts:34`), so the malformed body is committed to state and
 * `ProjectTree`'s `projects.find(...)` throws during render — inside the `(app)` layout, above
 * the page — where a boundary is the only thing that can catch it. A failed *request* is a
 * different path and reaches no boundary at all, which the last test here holds to.
 *
 * Everything is scoped to the boundary's own testid: the dev server keeps its own copy of the
 * same error, and telling the product's screen from the tooling's is not something a role or a
 * string can do.
 */

test.beforeEach(seed);

const BROKEN = { not: "an array" };

/** The app's own crash screen, told apart from the dev server's overlay of the same error. */
const boundary = (page: Page) => page.getByTestId("error-boundary");

async function crash(page: Page) {
  await page.route("**/api/projects", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BROKEN) })
  );
  await signIn(page);
  await page.goto("/projects");
  await expect(boundary(page).getByRole("heading", { name: "Something went wrong" })).toBeVisible();
}

test("the stack is there for a bug report, and behind a disclosure until asked for", async ({
  page,
}) => {
  await crash(page);

  // The error this test meant to cause, not merely some TypeError from elsewhere in the tree
  await expect(boundary(page).locator("p", { hasText: /projects\.find is not a function/ })).toBeVisible();

  const stack = boundary(page).locator("details > pre");
  await expect(stack).toBeHidden();
  const hidden = await boundary(page).innerText();

  await boundary(page).locator("summary").click();
  await expect(stack).toBeVisible();

  // The needle is taken from the stack the browser actually produced rather than from a pattern
  // this test carries: a hard-coded `_next` would stop matching the day the bundler's URLs change
  // and quietly make the assertion below vacuous
  const frame = (await stack.innerText())
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
  expect(frame, "the disclosure holds no stack frame, so there is nothing to hide").toBeTruthy();

  // What the disclosure was closed over is exactly what was not on the surface. Read as rendered
  // text, because a closed <details> keeps its content in the DOM — and because a stack printed
  // BESIDE the disclosure would satisfy "the disclosure is closed", which is the state this
  // replaced
  expect(hidden).not.toContain(frame!);
});

test("the details can be copied in one click", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await crash(page);

  await boundary(page).locator("summary").click();
  const stack = boundary(page).locator("details > pre");
  await expect(stack).toBeVisible();
  const shown = (await stack.innerText()).trim();

  // A sentinel first: the run before this one left an identical report on the clipboard, so
  // without it a button that stopped writing anything would still read back the right answer
  await page.evaluate(() => navigator.clipboard.writeText("sentinel-not-the-report"));

  await boundary(page).getByRole("button", { name: "Copy details" }).click();
  await expect(boundary(page).getByText("Copied")).toBeVisible();
  // Announced, not only painted: the button keeps its name so a reader is told the result rather
  // than hearing the control rename itself under them
  await expect(boundary(page).locator('[aria-live="polite"]')).toHaveText("Copied");

  expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(shown);

  // The label goes back, so a second copy can be told from the first — the state this had before
  await expect(boundary(page).getByText("Copied")).toHaveCount(0);
});

test("Try again re-renders in place, rather than reloading the page", async ({ page }) => {
  await crash(page);

  // Survives a re-render and does not survive a reload, which is the difference the assertions
  // below cannot otherwise see
  await page.evaluate(() => {
    (window as unknown as { __survivedTheRetry?: boolean }).__survivedTheRetry = true;
  });

  await page.unroute("**/api/projects");
  await boundary(page).getByRole("button", { name: "Try again", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByText("1 project", { exact: true })).toBeVisible();
  await expect(boundary(page)).toHaveCount(0);

  expect(
    await page.evaluate(
      () => (window as unknown as { __survivedTheRetry?: boolean }).__survivedTheRetry
    )
  ).toBe(true);
});

test("a request that fails is not a crash, and reaches no boundary", async ({ page }) => {
  // The control for the whole file: it is the render that summons this screen, not the endpoint
  // misbehaving. Without it, every test above would also pass on a page that showed the boundary
  // whenever a request went wrong
  await page.route("**/api/projects", (route) => route.fulfill({ status: 500, body: "no" }));
  await signIn(page);
  await page.goto("/projects");

  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(boundary(page)).toHaveCount(0);
  await expect(page.getByText(PROJECT_NAME)).toHaveCount(0);
});
