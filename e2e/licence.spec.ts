import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { MEMBER_AUTH } from "./api";
import { e2eLicence } from "./licence-key";
import { seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-650. LICENCE_KEY is read from the environment, and this run's server has one environment for
 * its whole life — so `POST /api/e2e/licence` swaps the value the server reads in its place.
 * Everything after that is the production path: the signature check against the build's keys (plus
 * the suite's own, see e2e/licence-key.ts), the entitlements every route sees, and the page.
 */

async function useLicenceKey(request: APIRequestContext, key: string | undefined) {
  const response = await request.post("/api/e2e/licence", { data: key === undefined ? {} : { key } });
  expect(response.status(), await response.text()).toBe(204);
}

async function planSeenByAMember(request: APIRequestContext): Promise<string> {
  const response = await request.get("/api/entitlements", { headers: MEMBER_AUTH });
  expect(response.status()).toBe(200);
  return (await response.json()).plan;
}

async function openLicenceSettings(page: Page) {
  await page.goto("/settings/profile");
  await page.getByRole("link", { name: "Licence" }).click();
  await expect(page).toHaveURL(/\/settings\/licence$/);
  await expect(page.getByRole("heading", { name: "Licence" })).toBeVisible();
}

function row(page: Page, label: string) {
  return page.getByTestId("licence-details").locator("div", { has: page.locator("dt", { hasText: label }) }).locator("dd");
}

test.beforeEach(async ({ page, request }) => {
  await seed();
  await useLicenceKey(request, undefined);
  await signIn(page);
});

test.afterEach(async ({ request }) => {
  await useLicenceKey(request, undefined);
});

test("with no key the instance is on the Free plan, and the page says so", async ({ page, request }) => {
  await openLicenceSettings(page);

  await expect(page.getByTestId("licence-free")).toContainText("Free plan");
  await expect(page.getByRole("link", { name: "How to get one" })).toHaveAttribute("href", /#licence-key$/);
  expect(await planSeenByAMember(request)).toBe("free");
});

test("a signed key turns the instance Pro and the page shows who it is for", async ({ page, request }) => {
  await useLicenceKey(request, e2eLicence({ customer: "Acme E2E Ltd", expiresInDays: 200 }));

  await openLicenceSettings(page);

  await expect(row(page, "Customer")).toHaveText("Acme E2E Ltd");
  await expect(row(page, "Plan")).toHaveText("Pro");
  await expect(row(page, "Days left")).toHaveText(/^(199|200)$/);
  await expect(page.getByTestId("licence-warning")).toHaveCount(0);
  expect(await planSeenByAMember(request)).toBe("pro");

  // Display only: nothing on the page takes a key or changes one
  const screen = page.getByTestId("licence-page");
  await expect(screen.locator("input, textarea, select, [contenteditable]")).toHaveCount(0);
  await expect(screen.getByRole("button")).toHaveCount(0);
});

test("each kind of bad key is named, and every one leaves the instance free", async ({ page, request }) => {
  const good = e2eLicence();
  const [body, signature] = good.split(".");
  const flipped = `${body}.${signature.slice(0, -2)}${signature.at(-2) === "A" ? "B" : "A"}${signature.at(-1)}`;
  const unknownKeyId = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), keyId: "retired" })
  ).toString("base64url");

  const cases = [
    { key: flipped, says: "its signature does not match its contents" },
    { key: `${unknownKeyId}.${signature}`, says: "signed by a key this build does not know" },
    { key: good.slice(0, -10), says: "is not a licence key" },
  ];

  // The control: the untampered key, through the same door, is Pro
  await useLicenceKey(request, good);
  expect(await planSeenByAMember(request)).toBe("pro");

  for (const { key, says } of cases) {
    await useLicenceKey(request, key);
    await openLicenceSettings(page);

    await expect(page.getByTestId("licence-refusal")).toContainText(says);
    await expect(page.getByTestId("licence-free")).toContainText("Free plan");
    expect(await planSeenByAMember(request)).toBe("free");
  }
});

test("an expired key keeps Pro with a warning through its grace, and is Free after it", async ({
  page,
  request,
}) => {
  await useLicenceKey(request, e2eLicence({ expiresInDays: -3 }));
  await openLicenceSettings(page);

  await expect(page.getByTestId("licence-warning")).toContainText("This licence has expired. Pro features stay on for 11 days");
  expect(await planSeenByAMember(request)).toBe("pro");

  await useLicenceKey(request, e2eLicence({ expiresInDays: -15 }));
  await openLicenceSettings(page);

  await expect(page.getByTestId("licence-warning")).toContainText("its grace period is over");
  await expect(row(page, "Plan")).toHaveText("Pro (expired)");
  expect(await planSeenByAMember(request)).toBe("free");
});

test("a key with under 30 days left warns before it runs out", async ({ page, request }) => {
  await useLicenceKey(request, e2eLicence({ expiresInDays: 12 }));
  await openLicenceSettings(page);

  await expect(page.getByTestId("licence-warning")).toContainText(/expires in 1[23] days/);
  expect(await planSeenByAMember(request)).toBe("pro");
});
