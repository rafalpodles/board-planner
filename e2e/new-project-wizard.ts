import { expect, type Page } from "@playwright/test";

/**
 * From the first step to Review, skipping every optional step: what clicking straight through the
 * wizard does. Leaves the page on Review with Create Project next.
 */
export async function skipToReview(page: Page) {
  await page.getByRole("button", { name: /^Next: Workflow/ }).click();
  for (const title of ["Task fields", "Automation & access", "Review"]) {
    await page.getByRole("button", { name: "Skip" }).click();
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  }
}
