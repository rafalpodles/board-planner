import { test, expect, type Page, type Route } from "@playwright/test";
import { PROJECT_KEY, SIBLING_TASK_NUMBER, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-800. A read of the comments that was already in flight when a comment was posted can answer
 * after the server saved it but before the post's own answer reaches the page. The composer used to
 * empty itself only on that answer, so for that moment the new comment sat in the list and, word
 * for word, in the box it was typed into.
 */

const TASK = `/projects/${PROJECT_KEY}/tasks/${SIBLING_TASK_NUMBER}`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

test.beforeEach(seed);

const isCommentsCollection = (url: URL) => /\/tasks\/[^/]+\/comments$/.test(url.pathname);

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Holds every read of the comments until the post has been saved, then lets them answer — with the
 * new comment in them — while the post's own answer is still held back.
 */
async function interleave(page: Page) {
  const saved = deferred();
  const answerPost = deferred();
  let holding = true;
  const heldReads: Promise<void>[] = [];

  await page.route(isCommentsCollection, async (route: Route) => {
    const method = route.request().method();
    if (method === "GET" && holding) {
      const reply = saved.promise.then(() => route.continue());
      heldReads.push(reply);
      return reply;
    }
    if (method === "POST") {
      const response = await route.fetch();
      holding = false;
      saved.resolve();
      await answerPost.promise;
      return route.fulfill({ response });
    }
    return route.continue();
  });

  return {
    heldReads: () => heldReads.length,
    saved: saved.promise,
    answerPost: answerPost.resolve,
  };
}

async function postWhileAReadIsInFlight(page: Page, which: "wide" | "phone", text: string) {
  const race = await interleave(page);
  const staleRead = page.waitForResponse(
    (r) => isCommentsCollection(new URL(r.url())) && r.request().method() === "GET"
  );
  await page.goto(TASK);

  const box =
    which === "wide"
      ? page.getByRole("textbox", { name: "Write a comment, @mention someone…" })
      : page.getByRole("textbox", { name: "Add a comment" });
  await expect(box).toBeVisible();
  await expect.poll(race.heldReads).toBeGreaterThan(0);
  await box.fill(text);
  await expect(box).toHaveValue(text);

  const posted = page.waitForResponse(
    (r) => isCommentsCollection(new URL(r.url())) && r.request().method() === "POST"
  );
  if (which === "wide") await page.getByRole("button", { name: "Comment", exact: true }).click();
  else await page.getByRole("button", { name: "Post comment" }).click();

  await race.saved;
  await staleRead;
  const panel = page.getByRole("tabpanel", { name: /Comments/ });
  await expect(panel.getByRole("paragraph").filter({ hasText: text })).toBeVisible();

  await expect(box).toHaveValue("");
  await expect(page.getByText(text)).toHaveCount(1);

  race.answerPost();
  expect((await posted).ok()).toBe(true);
  await page.waitForTimeout(1_000);
  await expect(page.getByText(text)).toHaveCount(1);
  await expect(box).toHaveValue("");
}

test("the wide composer is empty by the time an earlier read shows the new comment", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await signIn(page);
  await postWhileAReadIsInFlight(page, "wide", "Said once, on a desk");
});

test("the phone's bar is empty by the time an earlier read shows the new comment", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await signIn(page);
  await postWhileAReadIsInFlight(page, "phone", "Said once, on a phone");
});

// The control: nothing held, the ordinary post still lands exactly once and empties the box
test("an ordinary post still shows the comment once and empties the box", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signIn(page);
  await page.goto(TASK);
  const box = page.getByRole("textbox", { name: "Write a comment, @mention someone…" });
  await expect(box).toBeVisible();
  await box.fill("Said once, unhurried");
  const posted = page.waitForResponse(
    (r) => isCommentsCollection(new URL(r.url())) && r.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  expect((await posted).ok()).toBe(true);
  const panel = page.getByRole("tabpanel", { name: /Comments/ });
  await expect(panel.getByRole("paragraph").filter({ hasText: "Said once, unhurried" })).toBeVisible();
  await expect(box).toHaveValue("");
  await expect(page.getByText("Said once, unhurried")).toHaveCount(1);
});
