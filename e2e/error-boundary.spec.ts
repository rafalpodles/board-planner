import { test, expect, type Page } from "@playwright/test";
import { PROJECT_NAME, seed } from "./seed";
import { signIn } from "./session";

test.beforeEach(seed);

const BROKEN = { not: "an array" };

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

  await expect(boundary(page).locator("p", { hasText: /projects\.find is not a function/ })).toBeVisible();

  const stack = boundary(page).locator("details > pre");
  await expect(stack).toBeHidden();
  const hidden = await boundary(page).innerText();

  await boundary(page).locator("summary").click();
  await expect(stack).toBeVisible();

  const frame = (await stack.innerText())
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
  expect(frame, "the disclosure holds no stack frame, so there is nothing to hide").toBeTruthy();

  expect(hidden).not.toContain(frame!);
});

test("the details can be copied in one click", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await crash(page);

  await boundary(page).locator("summary").click();
  const stack = boundary(page).locator("details > pre");
  await expect(stack).toBeVisible();
  const shown = (await stack.innerText()).trim();

  await page.evaluate(() => navigator.clipboard.writeText("sentinel-not-the-report"));

  await boundary(page).getByRole("button", { name: "Copy details" }).click();
  await expect(boundary(page).getByText("Copied")).toBeVisible();
  await expect(boundary(page).locator('[aria-live="polite"]')).toHaveText("Copied");

  expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(shown);

  await expect(boundary(page).getByText("Copied")).toHaveCount(0);
});

test("Try again re-renders in place, rather than reloading the page", async ({ page }) => {
  await crash(page);

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
  await page.route("**/api/projects", (route) => route.fulfill({ status: 500, body: "no" }));
  await signIn(page);
  await page.goto("/projects");

  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(boundary(page)).toHaveCount(0);
  await expect(page.getByText(PROJECT_NAME)).toHaveCount(0);
});
