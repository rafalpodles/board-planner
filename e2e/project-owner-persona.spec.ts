import { test, expect } from "@playwright/test";
import { OWNER_USERNAME, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-563. No e2e test anywhere composed a genuine project owner — a Grant `relation: "owner"`,
 * with no standing on the instance at all — through an actual `withProjectOwner` route. "admin"
 * sign-in bypasses grant resolution entirely (`principal.instanceAdmin` in `src/lib/grants.ts`),
 * so it cannot exercise the `grant === "owner"` branch these routes actually depend on for
 * anyone who isn't an instance admin.
 *
 * `GET /api/projects/[projectId]/members` stands in for the ~13 `withProjectOwner` routes under
 * `[projectId]/` — same gate (`check(user, projectId, "admin")`), and, unlike the audit log or PM
 * usage routes, it was already `withProjectOwner` before BP-549/BP-562, so this persona is not
 * coupled to either of those still-unmerged fixes.
 */
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
