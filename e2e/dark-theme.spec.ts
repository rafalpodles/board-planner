import { test, expect, type Locator, type Page } from "@playwright/test";
import { ADMIN_AUTH } from "./api";
import { AA_TEXT, DARK_SURFACE_MAX_LUMINANCE, surfaceLuminance, textContrast, type PaintedText } from "./colour";
import {
  DECOY_TASK_NUMBER,
  DECOY_TASK_TITLE,
  FINISHED_TASK_ID,
  FINISHED_TASK_NUMBER,
  NAVY_CATEGORY,
  PALE_CATEGORY,
  PROJECT_ID,
  PROJECT_KEY,
  SIBLING_TASK_ID,
  SIBLING_TASK_NUMBER,
  SOURCE_COLUMN,
  SPARE_COLUMN,
  seed,
  seedHardColours,
} from "./seed";
import { signIn } from "./session";

/**
 * BP-702 decision: computed colours, not screenshots. The repo keeps no screenshot baseline, and a
 * failed one cannot say which colour is wrong. Asserted in dark: the board, a task, the dashboard
 * and the settings shell, which between them carry every surface token; in both themes: the chips
 * whose colour is project data. Dark is chosen through the app's own theme switch, against an
 * emulated light scheme.
 */

test.use({ colorScheme: "light" });

test.beforeEach(async () => {
  await seed();
  await seedHardColours();
});

const board = `/projects/${PROJECT_KEY}`;
const taskUrl = (n: number) => `${board}/tasks/${n}`;
const cardFor = (n: number) => `[data-column-body] a[href="${taskUrl(n)}"]`;

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

async function chooseTheme(page: Page, name: "Light" | "Dark") {
  await open(page, board);
  const group = page.getByRole("group", { name: "Theme" });
  await page.getByRole("button", { name: /E2E Admin/ }).click();
  await group.getByRole("button", { name, exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", name.toLowerCase());
  await page.mouse.move(0, 0);
}

async function painted(locator: Locator): Promise<PaintedText> {
  await expect(locator).toBeVisible();
  return locator.evaluate((element) => {
    const backgrounds: string[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      backgrounds.push(getComputedStyle(node).backgroundColor);
    }
    return { color: getComputedStyle(element).color, backgrounds };
  });
}

async function expectReadable(name: string, locator: Locator) {
  const ratio = textContrast(await painted(locator));
  expect.soft(ratio, `${name} reads at ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT);
}

async function expectDarkBehind(name: string, locator: Locator) {
  const luminance = surfaceLuminance((await painted(locator)).backgrounds);
  expect(luminance, `the surface behind ${name} has luminance ${luminance.toFixed(3)}`).toBeLessThanOrEqual(
    DARK_SURFACE_MAX_LUMINANCE
  );
}

test("the board, a task, the dashboard and settings all paint dark, with readable text", async ({
  page,
}) => {
  await signIn(page);
  await chooseTheme(page, "Dark");
  const main = page.locator("#main-content");

  await test.step("the board", async () => {
    await open(page, board);
    const column = page.getByTestId("column-in_review");
    const title = main.getByRole("heading", { level: 1 });
    await expectDarkBehind("the board title", title);
    await expectDarkBehind("a column", column.getByRole("heading", { name: "In Review", exact: true }));
    await expectReadable("the board title", title);
    await expectReadable("a column header", column.getByRole("heading", { name: "In Review", exact: true }));
    await expectReadable("its count", column.getByText("1", { exact: true }));
    const cardTitle = page.locator(cardFor(DECOY_TASK_NUMBER)).getByRole("heading");
    await expectDarkBehind("a card title", cardTitle);
    await expectReadable("a card title", cardTitle);
  });

  await test.step("a task", async () => {
    await open(page, taskUrl(DECOY_TASK_NUMBER));
    const title = main.getByRole("textbox", { name: "Task title" });
    await expect(title).toHaveValue(DECOY_TASK_TITLE);
    await expectDarkBehind("the task title", title);
    await expectReadable("the task title", title);
    await expectReadable("a section label", main.getByText("Description", { exact: true }));
    const details = main.getByRole("complementary");
    await expectDarkBehind("the details rail", details.getByText("Details", { exact: true }));
    await expectReadable("the details heading", details.getByText("Details", { exact: true }));
    await expectReadable("a property label", details.getByText("Priority", { exact: true }));
    await expectReadable("the empty comments line", main.getByText("No comments yet"));
    const commentBox = main.getByRole("textbox", { name: /Write a comment/ });
    await expectDarkBehind("the comment box", commentBox);
  });

  await test.step("the dashboard", async () => {
    await open(page, `${board}/dashboard`);
    const heading = main.getByRole("heading", { name: "Dashboard" });
    await expectDarkBehind("the dashboard heading", heading);
    await expectDarkBehind("a chart card", main.getByRole("heading", { name: "Status Breakdown" }));
    await expectReadable("the dashboard heading", heading);
    await expectReadable("a chart title", main.getByRole("heading", { name: "Status Breakdown" }));
    await expectReadable("a stat label", main.getByText("Total Tasks", { exact: true }));
    await expectReadable("a chart legend", main.getByText("In Review", { exact: true }).first());
  });

  await test.step("the settings shell", async () => {
    await open(page, `${board}/settings`);
    const heading = main.getByRole("heading", { name: "Settings", exact: true });
    await expectDarkBehind("the settings heading", heading);
    await expectReadable("the settings heading", heading);
    await expectReadable("a section heading", main.getByRole("heading", { name: "General", exact: true }));
    await expectReadable("a section description", main.getByText(/^What this project is called/));
    const nav = main.getByRole("navigation", { name: "Settings sections" });
    await expectReadable("the selected section", nav.getByRole("button", { name: "General" }));
    await expectReadable("another section", nav.getByRole("button", { name: "Task fields" }));
    await expectReadable("the nav's group label", nav.getByRole("heading", { name: "Project" }));
  });
});

for (const theme of ["Light", "Dark"] as const) {
  test(`a project's own column and category colours stay readable — ${theme.toLowerCase()}`, async ({
    page,
  }) => {
    await signIn(page);
    const linked = await page.request.post(
      `/api/projects/${PROJECT_ID}/tasks/${SIBLING_TASK_ID}/links`,
      { headers: ADMIN_AUTH, data: { taskId: String(FINISHED_TASK_ID), type: "relates" } }
    );
    expect(linked.status(), await linked.text()).toBe(200);
    await chooseTheme(page, theme);
    const main = page.locator("#main-content");

    await test.step("category chips on the cards", async () => {
      await open(page, board);
      await expectReadable(
        `${PALE_CATEGORY} (pale yellow)`,
        page.locator(cardFor(FINISHED_TASK_NUMBER)).getByText(PALE_CATEGORY, { exact: true })
      );
      await expectReadable(
        `${NAVY_CATEGORY} (navy)`,
        page.locator(cardFor(SIBLING_TASK_NUMBER)).getByText(NAVY_CATEGORY, { exact: true })
      );
    });

    await test.step("column colours on the list's status chips", async () => {
      await page.getByRole("button", { name: "List", exact: true }).click();
      const row = (n: number) => page.getByRole("row", { name: new RegExp(`${PROJECT_KEY}-${n}\\b`) });
      await expectReadable(
        `${SPARE_COLUMN.label} (navy)`,
        row(FINISHED_TASK_NUMBER).getByText(SPARE_COLUMN.label, { exact: true })
      );
      await expectReadable(
        `${SOURCE_COLUMN.label} (pale yellow)`,
        row(SIBLING_TASK_NUMBER).getByText(SOURCE_COLUMN.label, { exact: true })
      );
    });

    await test.step("the board filter's category chip", async () => {
      await open(page, board);
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      const panel = page.getByRole("dialog", { name: "Filters" });
      for (const [category, colour] of [
        [PALE_CATEGORY, "pale yellow"],
        [NAVY_CATEGORY, "navy"],
      ]) {
        await panel.getByLabel("Category").selectOption(category);
        const chip = panel
          .getByRole("button", { name: `Remove ${category} filter` })
          .locator("..")
          .getByText(category, { exact: true });
        await expectReadable(`the ${category} filter chip (${colour})`, chip);
      }
    });

    await test.step("column colours on My Tasks", async () => {
      await open(page, "/my-tasks");
      const row = (n: number) => main.getByRole("link", { name: new RegExp(`${PROJECT_KEY}-${n}\\b`) });
      await expectReadable(
        `My Tasks ${SPARE_COLUMN.label} (navy)`,
        row(FINISHED_TASK_NUMBER).getByText(SPARE_COLUMN.label, { exact: true })
      );
      await expectReadable(
        `My Tasks ${SOURCE_COLUMN.label} (pale yellow)`,
        row(SIBLING_TASK_NUMBER).getByText(SOURCE_COLUMN.label, { exact: true })
      );
    });

    await test.step("a task's status, its type, and a linked task's status", async () => {
      const statusPill = main.getByRole("combobox", { name: "Status" }).locator(".chip");
      const typeChip = (name: string) =>
        main.getByRole("combobox", { name: "Type" }).getByText(name, { exact: true });

      await open(page, taskUrl(FINISHED_TASK_NUMBER));
      await expect(statusPill).toContainText(SPARE_COLUMN.label);
      await expectReadable(`the ${SPARE_COLUMN.label} status (navy)`, statusPill);
      await expectReadable(`the ${PALE_CATEGORY} type (pale yellow)`, typeChip(PALE_CATEGORY));
      await expectReadable(
        `the linked task's ${SOURCE_COLUMN.label} status (pale yellow)`,
        main.getByText(SOURCE_COLUMN.label, { exact: true })
      );

      await open(page, taskUrl(SIBLING_TASK_NUMBER));
      await expect(statusPill).toContainText(SOURCE_COLUMN.label);
      await expectReadable(`the ${SOURCE_COLUMN.label} status (pale yellow)`, statusPill);
      await expectReadable(`the ${NAVY_CATEGORY} type (navy)`, typeChip(NAVY_CATEGORY));
      await expectReadable(
        `the linked task's ${SPARE_COLUMN.label} status (navy)`,
        main.getByText(SPARE_COLUMN.label, { exact: true })
      );
    });
  });
}
