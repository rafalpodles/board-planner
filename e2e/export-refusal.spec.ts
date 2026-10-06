import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, seed } from "./seed";
import { signIn } from "./session";

test.beforeEach(seed);

// BP-921: a bare download link saved whatever the server answered, a refusal included, as the export
test("a refused export says why on the page and saves nothing", async ({ page }) => {
  await signIn(page, "admin");
  await page.route((url) => url.pathname === "/api/admin/export" && url.searchParams.get("check") === "1", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "The database is unreachable. This is not a problem with your session." }) })
  );
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });

  await page.goto("/settings/export");
  await page.getByRole("button", { name: "Download the export" }).click();

  await expect(page.getByTestId("export-error")).toContainText("The database is unreachable");
  await page.waitForTimeout(500);
  expect(downloaded).toBe(false);
  await page.screenshot({ path: "e2e/.artifacts/bp921-export-refused.png" });
});

test("an export that is answered is saved under the file name the server gives", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/settings/export");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download the export" }).click()]);
  expect(download.suggestedFilename()).toMatch(/-export-\d{4}-\d{2}-\d{2}\.ndjson\.gz$/);
});

test("the check before a download answers without exporting anything or recording an export", async ({ page }) => {
  await signIn(page, "admin");
  const check = await page.request.get("/api/admin/export?check=1");
  expect(check.status()).toBe(204);
  expect(await check.body()).toHaveLength(0);
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  expect(await mongoose.connection.db!.collection("instanceauditlogs").countDocuments({ action: "organisation_exported" })).toBe(0);
  await mongoose.disconnect();
});
