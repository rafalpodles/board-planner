import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { API_TOKEN, MEMBER_ID, MEMBER_USERNAME, OWNER_USERNAME, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-848. An owner choosing "No access" on their own row used to stage it like any other change,
 * and one Save later the board was gone. Their own removal now asks first; stepping down to member
 * does not.
 */

test.beforeEach(seed);

const ownAccess = (page: Page) => page.getByLabel(`Access for ${OWNER_USERNAME}`);

async function openMembers(page: Page) {
  await page.goto(`/projects/${PROJECT_KEY}/settings?section=general`);
  await expect(ownAccess(page)).toHaveValue("owner");
}

async function makeMemberAnOwner(request: APIRequestContext) {
  const granted = await request.put(`/api/projects/${String(PROJECT_ID)}/members`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    data: { userId: String(MEMBER_ID), relation: "owner" },
  });
  expect(granted.status()).toBe(200);
}

function membersWrite(page: Page, method: string) {
  return page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith("/members") && r.request().method() === method
  );
}

test("a non-last owner's own removal waits for Remove myself", async ({ page, request }) => {
  await makeMemberAnOwner(request);
  await signIn(page, "owner");
  await openMembers(page);

  await ownAccess(page).selectOption("none");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("immediately lose access");
  await expect(dialog).toContainText("Only another owner or an admin can add you back");
  await expect(ownAccess(page)).toHaveValue("owner");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(ownAccess(page)).toHaveValue("owner");
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);

  await ownAccess(page).selectOption("none");
  await page.getByRole("button", { name: "Remove myself" }).click();
  await expect(ownAccess(page)).toHaveValue("none");

  const removed = membersWrite(page, "DELETE");
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await removed).status()).toBe(200);
  await expect(page).toHaveURL(/\/projects$/);
});

test("the last owner's own removal is refused and the row stays owner", async ({ page }) => {
  await signIn(page, "owner");
  await openMembers(page);

  await ownAccess(page).selectOption("none");
  await page.getByRole("button", { name: "Remove myself" }).click();

  const refused = membersWrite(page, "DELETE");
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await refused).status()).toBe(409);

  await expect(page.getByText("A board must keep at least one owner")).toBeVisible();
  await expect(ownAccess(page)).toHaveValue("owner");
  await expect(page).toHaveURL(/\/settings/);

  await page.reload();
  await expect(ownAccess(page)).toHaveValue("owner");
});

test("stepping down to member asks nothing and lands", async ({ page, request }) => {
  await makeMemberAnOwner(request);
  await signIn(page, "owner");
  await openMembers(page);

  await ownAccess(page).selectOption("member");
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled();
  expect(await page.getByRole("dialog").count()).toBe(0);

  const demoted = membersWrite(page, "PUT");
  await page.getByRole("button", { name: "Save changes" }).click();
  expect((await demoted).status()).toBe(200);
  await expect(page).toHaveURL(/\/settings/);

  const listed = await request.get(`/api/projects/${String(PROJECT_ID)}/members`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  const rows = (await listed.json()) as { username: string; relation: string | null }[];
  expect(rows.find((r) => r.username === OWNER_USERNAME)?.relation).toBe("member");
  expect(rows.find((r) => r.username === MEMBER_USERNAME)?.relation).toBe("owner");
});
