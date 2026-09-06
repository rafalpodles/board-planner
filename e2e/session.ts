import { expect, type BrowserContext, type Page } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_SESSION_TOKEN,
  ADMIN_USERNAME,
  MEMBER_SESSION_TOKEN,
  OWNER_SESSION_TOKEN,
} from "./seed";

const COOKIE_NAME = "__Host-bp_session";

type Who = "admin" | "member" | "owner";

const TOKENS: Record<Who, string> = {
  admin: ADMIN_SESSION_TOKEN,
  member: MEMBER_SESSION_TOKEN,
  owner: OWNER_SESSION_TOKEN,
};

export async function signIn(page: Page, who: Who = "admin"): Promise<void> {
  await signInContext(page.context(), who);
}

export async function signInContext(context: BrowserContext, who: Who = "admin"): Promise<void> {
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: TOKENS[who],
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);

  const me = await context.request.get("/api/auth/me");
  expect(me.status(), `the seeded ${who} session did not authenticate — did this spec seed()?`).toBe(
    200
  );
}

export async function signInThroughForm(
  page: Page,
  username = ADMIN_USERNAME,
  password = ADMIN_PASSWORD
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}
