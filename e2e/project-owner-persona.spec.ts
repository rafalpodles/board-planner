import { test, expect } from "@playwright/test";
import { OWNER_USERNAME, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

test.beforeEach(seed);

test("a genuine project owner (not instance admin) passes a withProjectOwner route", async ({
  page,
}) => {
  await signIn(page, "owner");

  const res = await page.request.get(`/api/projects/${PROJECT_KEY}/members`);
  expect(res.status()).toBe(200);

  const members = await res.json();
  expect(members).toContainEqual(
    expect.objectContaining({ username: OWNER_USERNAME, relation: "owner", instanceAdmin: false })
  );
});

test("a plain member is refused the same route", async ({ page }) => {
  await signIn(page, "member");

  const res = await page.request.get(`/api/projects/${PROJECT_KEY}/members`);
  expect(res.status()).toBe(403);
});
