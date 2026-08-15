import { test, expect, type Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME, PROJECT_KEY, seed } from "./seed";

/**
 * BP-340. Every field in every modal drew its focus ring along the top and bottom only: the modal
 * body scrolls, a scrollport clips whatever its descendants paint outside it, and a full-width
 * field sits flush against that edge.
 *
 * Two things this deliberately does NOT do. It does not diff screenshots — that found the bug, but
 * it is slow and reports a field merely *covered* by an open modal as clipped. And it does not grep
 * the source for `focus:ring-*`: the unit guard already does that, and the class of bug survives it
 * anyway, because a correct `.focus-ring` in a new flush scroller is clipped exactly as hard. An
 * outline is not spared — measured, both mechanisms lose both sides.
 *
 * So the question asked here is geometric: does what the focus treatment paints fit inside the
 * nearest scrollport, on the axis that does not scroll? A field scrolled out of view vertically is
 * not a defect; a field whose ring has nowhere to go sideways is.
 */

test.beforeEach(seed);

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/\/projects/);
}

type FieldReport = {
  where: string;
  grow: number;
  indicator: boolean;
  clipped: string[];
  free: Record<string, number>;
};

/**
 * Resolved in the page, from the stylesheets rather than from a live `:focus` — Playwright can
 * focus one element at a time, and this has to answer for every field on the screen at once.
 */
const COLLECT = () => {
  const hidden = (el: Element) => {
    let p: Element | null = el;
    while (p && p !== document.documentElement) {
      const s = getComputedStyle(p);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return true;
      p = p.parentElement;
    }
    return false;
  };

  const focusRules: CSSStyleRule[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | undefined;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const walk = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        const grouping = rule as CSSGroupingRule;
        if (grouping.cssRules?.length) {
          walk(grouping.cssRules);
          continue;
        }
        const styleRule = rule as CSSStyleRule;
        if (styleRule.selectorText?.includes(":focus")) focusRules.push(styleRule);
      }
    };
    if (rules) walk(rules);
  }

  /** What the focus treatment paints outside the border box, in px, and whether it paints at all. */
  const treatment = (el: Element) => {
    let outlineWidth = 0;
    let outlineOffset = 0;
    let recolours = false;
    for (const rule of focusRules) {
      const applies = rule.selectorText
        .split(",")
        .some((part) => {
          const base = part.trim().replace(/::?focus-visible|::?focus-within|::?focus/g, "");
          if (!base) return false;
          try {
            return el.matches(base);
          } catch {
            return false;
          }
        });
      if (!applies) continue;
      const width = /(-?\d+(?:\.\d+)?)px/.exec(rule.style.getPropertyValue("outline-width") || rule.style.outline);
      if (width) outlineWidth = parseFloat(width[1]);
      const offset = /(-?\d+(?:\.\d+)?)px/.exec(rule.style.getPropertyValue("outline-offset"));
      if (offset) outlineOffset = parseFloat(offset[1]);
      if (rule.style.getPropertyValue("border-color") || rule.style.getPropertyValue("box-shadow")) {
        recolours = true;
      }
    }
    // Tailwind's ring is a box-shadow whose spread the shorthand hides behind custom properties;
    // the class name is the honest source for how far out it lands.
    const classes = el.getAttribute("class") ?? "";
    const ring = /(?:^|\s|:)ring-(\d+)\b/.exec(classes);
    const ringGrow = ring && !/ring-inset/.test(classes) ? parseFloat(ring[1]) : 0;

    const outlineGrow = outlineWidth > 0 ? Math.max(0, outlineWidth + outlineOffset) : 0;
    return {
      grow: Math.max(outlineGrow, ringGrow),
      indicator: outlineWidth > 0 || ringGrow > 0 || recolours,
    };
  };

  /**
   * The nearest ancestor whose overflow makes it a scrollport, and which axes genuinely scroll.
   *
   * Not `overflow-x: auto` — that is the trap. Setting `overflow-y: auto` computes `overflow-x` to
   * `auto` too, so a plain vertical scroller *claims* both axes, and a check that skips whatever
   * "scrolls" ends up skipping everything and asserting nothing. Whether the content actually
   * overflows the axis is the honest question: if it does not, the axis never moves, and a ring
   * clipped there can never be scrolled into view.
   */
  const scrollport = (el: Element) => {
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") {
        return {
          el: p,
          scrollsX: p.scrollWidth > p.clientWidth + 1,
          scrollsY: p.scrollHeight > p.clientHeight + 1,
        };
      }
      p = p.parentElement;
    }
    return null;
  };

  const out: FieldReport[] = [];
  const fields = Array.from(
    document.querySelectorAll<HTMLElement>(
      'input:not([type=hidden]),textarea,select,[contenteditable="true"]'
    )
  );
  for (const el of fields) {
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    if (hidden(el)) continue;
    if ((el as HTMLInputElement).disabled) continue;

    const { grow, indicator } = treatment(el);
    const label =
      el.getAttribute("aria-label") ||
      (el as HTMLInputElement).placeholder ||
      (el as HTMLInputElement).name ||
      el.id ||
      el.tagName.toLowerCase();
    const where = `${el.tagName.toLowerCase()} "${label}"`;

    const port = scrollport(el);
    const clipped: string[] = [];
    const free: Record<string, number> = {};
    if (port && grow > 0) {
      const pr = port.el.getBoundingClientRect();
      const ps = getComputedStyle(port.el);
      const edges: Record<string, number> = {
        left: rect.left - (pr.left + parseFloat(ps.borderLeftWidth)),
        right: pr.right - parseFloat(ps.borderRightWidth) - rect.right,
        top: rect.top - (pr.top + parseFloat(ps.borderTopWidth)),
        bottom: pr.bottom - parseFloat(ps.borderBottomWidth) - rect.bottom,
      };
      // Only the axis that does not scroll: on a vertical scroller a field below the fold has a
      // negative bottom margin and is perfectly fine, it is simply further down the content.
      const axes = [
        ...(port.scrollsX ? [] : ["left", "right"]),
        ...(port.scrollsY ? [] : ["top", "bottom"]),
      ];
      for (const side of axes) {
        free[side] = Math.round(edges[side] * 10) / 10;
        if (edges[side] < grow) clipped.push(side);
      }
    }
    out.push({ where, grow, indicator, clipped, free });
  }
  return out;
};

async function fieldsOn(page: Page): Promise<FieldReport[]> {
  return page.evaluate(COLLECT);
}

/**
 * Fields whose lack of an outward indicator is a decision, not an oversight. `SearchLayer` says so
 * in a comment: its input is focused from the moment the layer opens and the caret marks it, where
 * a ring would read as a validation error.
 */
const NO_INDICATOR_BY_DESIGN = [/Search tasks and projects/];

const SCREENS: { name: string; open: (page: Page) => Promise<unknown> }[] = [
  {
    name: "new task modal",
    open: async (page) => {
      await page.goto(`/projects/${PROJECT_KEY}`);
      await page.getByRole("button", { name: /New task/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "new sprint modal",
    open: async (page) => {
      await page.goto(`/projects/${PROJECT_KEY}/sprints`);
      await page.getByRole("button", { name: "New Sprint" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "api tokens",
    open: async (page) => {
      await page.goto("/settings/tokens");
      await expect(page.getByPlaceholder(/Token name/)).toBeVisible();
    },
  },
  {
    name: "project settings",
    open: async (page) => {
      await page.goto(`/projects/${PROJECT_KEY}/settings`);
      await expect(page.getByLabel("Project name")).toBeVisible();
    },
  },
];

for (const screen of SCREENS) {
  test(`no focus ring is clipped by a scroll container — ${screen.name}`, async ({ page }) => {
    await signIn(page);
    await screen.open(page);

    const fields = await fieldsOn(page);
    expect(fields.length, "found no fields to check, so this proves nothing").toBeGreaterThan(0);

    const clipped = fields
      .filter((f) => f.clipped.length)
      .map((f) => `${f.where} loses ${f.clipped.join(" and ")} (ring ${f.grow}px, free ${JSON.stringify(f.free)})`);
    expect(clipped).toEqual([]);
  });

  test(`every field shows a focus indicator — ${screen.name}`, async ({ page }) => {
    await signIn(page);
    await screen.open(page);

    const missing = (await fieldsOn(page))
      .filter((f) => !f.indicator)
      .filter((f) => !NO_INDICATOR_BY_DESIGN.some((allowed) => allowed.test(f.where)))
      .map((f) => f.where);
    expect(missing).toEqual([]);
  });
}
