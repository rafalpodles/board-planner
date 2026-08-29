import { test, expect, type APIRequestContext } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { PROJECT_KEY, DECOY_TASK_NUMBER, seed } from "./seed";
import { signIn as arriveSignedIn } from "./session";

/**
 * BP-492. The board moves cards with native HTML5 drag, which a touch browser never starts —
 * so a phone had no way to move a task at all, while the list view (dnd-kit) did.
 *
 * The card's actions button opens the same menu right-click opens on a desktop.
 */

test.beforeEach(seed);

const signIn = arriveSignedIn;

const PHONE = { width: 390, height: 780 };

async function statusOf(request: APIRequestContext) {
  const response = await request.get(`/api/projects/${PROJECT_KEY}/tasks`, { headers: ADMIN_AUTH });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const body = await response.json();
  const tasks = body.tasks ?? body;
  return tasks.find((t: { taskNumber: number }) => t.taskNumber === DECOY_TASK_NUMBER)?.status;
}

test.describe("moving a card on a phone", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("the card's actions button moves the task, with no drag involved", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_KEY}`);

    const actions = page.getByRole("button", {
      name: `Actions for ${PROJECT_KEY}-${DECOY_TASK_NUMBER}`,
    });
    await expect(actions).toBeVisible();

    const before = await statusOf(request);
    expect(before).not.toBe("todo");

    await actions.click();
    const target = page.getByRole("button", { name: "To Do", exact: true });
    await expect(target).toBeVisible();

    // The board renders the move optimistically, so the rendered column proves nothing about
    // whether it landed — wait for the write itself
    const written = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes("/tasks/") && r.ok(),
    );
    await target.click();
    await written;

    expect(await statusOf(request)).toBe("todo");
  });
});

test("on a desktop the card keeps drag and right-click, and grows no extra button", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);

  // The control: the same card is on screen, so a hidden button is a decision and not an
  // absent card
  await expect(page.getByText(`${PROJECT_KEY}-${DECOY_TASK_NUMBER}`).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Actions for ${PROJECT_KEY}-${DECOY_TASK_NUMBER}` }),
  ).toBeHidden();
});
