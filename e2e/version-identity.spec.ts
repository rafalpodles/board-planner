import { test, expect } from "@playwright/test";
import { MEMBER_AUTH } from "./api";
import { seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-723. Nothing on a running instance said which build it was. The version and the commit are
 * read from the process environment at request time, so what the screen shows has to be the
 * answer the endpoint gives and not a literal the build machine left behind.
 *
 * The suite runs `next dev` with no commit variable, so the commit reads `unknown` here; the unit
 * tests cover a real one. What this pins is that the two surfaces are one fact and that a member,
 * not only an admin, can read it.
 */
const TOKEN = /^\d+\.\d+\.\d+\S* · (unknown|[0-9a-f]{7})$/;

test.beforeEach(async () => {
  await seed();
});

test("a member reads which build is running in Settings → Organisation, and copies it", async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, "member");
  await page.goto("/settings/organisation");

  const token = page.getByTestId("build-version-token");
  await expect(token).toHaveText(TOKEN);
  const shown = (await token.innerText()).trim();

  const answer = await request.get("/api/version", { headers: MEMBER_AUTH });
  expect(answer.status(), await answer.text()).toBe(200);
  const body = await answer.json();
  expect(`${body.version} · ${body.shortSha}`).toBe(shown);
  expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false);

  await page.getByTestId("build-version").getByRole("button", { name: "Copy" }).click();
  await expect(page.getByTestId("build-version").getByRole("button", { name: "Copied!" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
});

test("an anonymous caller is not told what runs here", async ({ request }) => {
  const res = await request.get("/api/version");

  expect(res.status()).toBe(401);
  expect(await res.text()).not.toMatch(/\d+\.\d+\.\d+/);
});
