import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_SESSION_TOKEN,
  ADMIN_USERNAME,
  MEMBER_SESSION_TOKEN,
} from "./seed";

/**
 * Arriving already signed in.
 *
 * Every spec used to carry its own copy of a sign-in helper — 31 of them, 236 calls, each one a
 * page load, two fills, a submit and a redirect. seed() wipes the database before every test, so
 * a cookie could not survive from one to the next and the form had to be driven again.
 *
 * seed() now lays down the session row itself, which makes signing in one cookie. The cookie is
 * `__Host-` prefixed and so must carry Secure, which Chrome accepts over http on localhost
 * because localhost is a trustworthy origin.
 *
 * This does NOT navigate: the caller goes wherever its test is about. Use `signInThroughForm`
 * where the form is the subject — the auth, password and reset specs — so the real path keeps a
 * reader.
 */
const COOKIE_NAME = "__Host-bp_session";

type Who = "admin" | "member";

const TOKENS: Record<Who, string> = {
  admin: ADMIN_SESSION_TOKEN,
  member: MEMBER_SESSION_TOKEN,
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
}

/** A second browser, signed in as the same person — for the specs that need two devices. */
export async function signedInPage(browser: Browser, who: Who = "admin"): Promise<Page> {
  const context = await browser.newContext();
  await signInContext(context, who);
  return context.newPage();
}

/** The real form. Only for specs whose subject is signing in. */
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
