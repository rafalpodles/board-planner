import { test, expect } from "@playwright/test";
import mongoose from "mongoose";
import { E2E_MONGODB_URI, PROJECT_ID, PROJECT_KEY, seed } from "./seed";
import { signIn } from "./session";

/**
 * BP-547 item 2. A picker with `searchThreshold` options or more grows a search box and focuses
 * it, and from that point the arrows move a highlight in a list the focused element said nothing
 * about — so a screen reader announces nothing as they move. The input also had a bare
 * `outline-none`, which escapes `focus-treatment.test.ts` (it matches `focus:outline-none`) and
 * every screen in `focus-ring.spec.ts`, none of which has a panel open.
 *
 * Nothing in the suite typed into that box before this spec, which is why both were invisible.
 * The seed has no field with enough options to grow one, so this makes its own.
 */

const FIELD_ID = new mongoose.Types.ObjectId("e2e00000000000000000f099");

const MANY_OPTIONS = {
  _id: FIELD_ID,
  name: "Surface",
  // `multiselect`, because that is the shape TaskForm renders through `MultiSelect` → `Combobox`;
  // a plain `dropdown` there is a native <select> with no search box at all
  fieldType: "multiselect",
  required: false,
  order: 9,
  showOnCard: false,
  showInList: false,
  filterable: false,
  archived: false,
  options: Array.from({ length: 9 }, (_, i) => ({
    id: `surface-${i}`,
    value: `Surface ${i}`,
    color: "#64748b",
    order: i,
  })),
};

test.beforeEach(async () => {
  await seed();
  if (mongoose.connection.readyState === 0) await mongoose.connect(E2E_MONGODB_URI);
  await mongoose.connection
    .db!.collection("projects")
    .updateOne({ _id: PROJECT_ID }, { $push: { customFields: MANY_OPTIONS } } as never);
  await mongoose.disconnect();
});

test("the picker's search box says which option the arrows are on", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "New task" }).click();

  const modal = page.getByRole("dialog", { name: "New Task" });
  await expect(modal.getByPlaceholder("Describe what you need")).toBeVisible();
  await modal.getByRole("combobox", { name: "Surface" }).click();

  const box = page.getByRole("combobox", { name: "Search Surface" });
  await expect(box, "a panel with nine options grows a search box").toBeVisible();
  await expect(box).toBeFocused();

  const listbox = page.getByRole("listbox", { name: "Surface" });
  await expect(box).toHaveAttribute("aria-controls", (await listbox.getAttribute("id"))!);
  await expect(box).toHaveAttribute("aria-expanded", "true");

  // `getElementById`, not a `#id` selector: React's own ids contain colons, which are not valid
  // in CSS without escaping
  const named = async () =>
    box.evaluate((el) => {
      const id = el.getAttribute("aria-activedescendant");
      return id ? (document.getElementById(id)?.textContent ?? null) : null;
    });

  // Read from the list rather than assumed: a multiselect panel opens with a "Clear all" row of
  // its own above the field's options, and an assertion that named the field's first option would
  // have been wrong about the fixture rather than about the wiring
  const rows = await page
    .locator('[role="option"]')
    .evaluateAll((els) => els.map((el) => el.textContent ?? ""));
  expect(rows.length, "nine options and the panel's own Clear all").toBeGreaterThan(9);

  expect(await named(), "the highlight starts on the first row").toBe(rows[0]);

  await box.press("ArrowDown");
  expect(await named(), "and the focused element follows it").toBe(rows[1]);

  await box.fill("Surface 7");
  expect(await named(), "typing moves it to the first match, not a stale row").toContain("Surface 7");

  await box.fill("no such surface");
  expect(await box.getAttribute("aria-activedescendant")).toBeNull();
});

test("the search box's focus ring is drawn where the panel cannot crop it", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_KEY}`);
  await page.getByRole("button", { name: "New task" }).click();

  const modal = page.getByRole("dialog", { name: "New Task" });
  await expect(modal.getByPlaceholder("Describe what you need")).toBeVisible();
  await modal.getByRole("combobox", { name: "Surface" }).click();

  const box = page.getByRole("combobox", { name: "Search Surface" });
  await expect(box).toBeFocused();

  const ring = await box.evaluate((el) => {
    const style = getComputedStyle(el);
    const panel = el.parentElement!;
    const offset = parseFloat(style.outlineOffset);
    const width = parseFloat(style.outlineWidth);
    const box = el.getBoundingClientRect();
    const within = panel.getBoundingClientRect();
    return {
      painted: style.outlineStyle !== "none" && width > 0,
      // An outline offset outwards is cropped by the panel's own `overflow-hidden`; the inset
      // variant is drawn inside the field, where nothing can clip it
      escapes: offset > 0 && (box.top - offset - width < within.top || box.left - offset - width < within.left),
    };
  });

  expect(ring.painted, "the field a keyboard lands on shows nothing at all").toBe(true);
  expect(ring.escapes, "the ring is painted outside a panel that clips it").toBe(false);
});
