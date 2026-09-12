import type { Page } from "@playwright/test";

/** What `/api/admin/email` returns, kept in step with `emailSettingsSummary()` by the compiler. */
type EmailSettings = ReturnType<typeof import("../src/lib/email").emailSettingsSummary>;

/**
 * Answers `/api/admin/email` as an instance with no mail server.
 *
 * Three specs assert what the mail screen says in that state, and since BP-465 the run always has
 * one — so the state has to be arranged rather than inherited. It is the *answer* those tests were
 * ever about, not the environment behind it.
 *
 * Typed rather than free-form, because the same literal was hand-copied into three files: a field
 * added to the route's shape now fails the type check here instead of leaving three fixtures
 * quietly describing a response the route no longer sends. The type is imported without importing
 * the module, which reads SMTP_* at load and would otherwise tie this to the runner's environment.
 */
export async function answerNoMailServer(page: Page) {
  const unconfigured: EmailSettings = {
    configured: false,
    host: "",
    port: 587,
    user: "",
    from: "",
  };
  await page.route("**/api/admin/email", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(unconfigured),
    })
  );
}
