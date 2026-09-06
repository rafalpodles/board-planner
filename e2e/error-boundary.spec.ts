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
 * The crash is caused rather than simulated: the projects list is answered with a shape it cannot
 * render, which throws during render — where a boundary is the only thing that can catch it. The
 * page's own `catch` covers the fetch and not the render, which is exactly why this reaches the
 * boundary and a failed request does not.
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
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
}

test("the stack is there for a bug report, and behind a disclosure until asked for", async ({
  page,
}) => {
  await crash(page);

  // What is on the surface: a sentence, not a stack. The <p>, specifically — the same words are
  // inside the disclosure, and it is where they are that this test is about
  await expect(boundary(page).locator("p", { hasText: /is not a function/ })).toBeVisible();

  // Nothing on this screen shows a frame until it is asked for. Read as rendered text, not as a
  // locator count: a closed <details> keeps its content in the DOM, and "the disclosure is closed"
  // would also be satisfied by a stack printed beside it — which is the state this replaced
  expect(await boundary(page).innerText()).not.toMatch(/at .+_next/);

  const stack = boundary(page).locator("details > pre");
  await expect(stack).toBeHidden();

  await boundary(page).locator("summary").click();
  await expect(stack).toBeVisible();
  // A real stack, not the message repeated: frames carry the chunk they came from
  await expect(stack).toContainText(/_next|at /);
});

test("the details can be copied in one click", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await crash(page);

  await boundary(page).locator("summary").click();
  const shown = (await boundary(page).locator("details > pre").innerText()).trim();

  await boundary(page).getByRole("button", { name: "Copy details" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard.trim()).toBe(shown);
});

test("Try again re-renders the page it broke on", async ({ page }) => {
  await crash(page);

  // The control: the boundary is not a dead end, and the retry re-runs the render rather than
  // reloading — so the answer it gets has to be a working one
  await page.unroute("**/api/projects");
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByText(PROJECT_NAME).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0);
});
