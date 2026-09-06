import { test, expect, type Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME, PROJECT_KEY, seed } from "./seed";
import { signIn as arriveSignedIn } from "./session";

test.beforeEach(seed);

const signIn = arriveSignedIn;

type FieldReport = {
  where: string;
  grow: number;
  indicator: boolean;
  clipped: string[];
  free: Record<string, number>;
};

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
    const classes = el.getAttribute("class") ?? "";
    const ring = /(?:^|\s|:)ring-(\d+)\b/.exec(classes);
    const ringGrow = ring && !/ring-inset/.test(classes) ? parseFloat(ring[1]) : 0;

    const outlineGrow = outlineWidth > 0 ? Math.max(0, outlineWidth + outlineOffset) : 0;
    return {
      grow: Math.max(outlineGrow, ringGrow),
      indicator: outlineWidth > 0 || ringGrow > 0 || recolours,
    };
  };

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

const NO_INDICATOR_BY_DESIGN = [/Search tasks and projects/];

const SCREENS: { name: string; open: (page: Page) => Promise<unknown> }[] = [
  {
    name: "new task modal",
    open: async (page) => {
      await page.goto(`/projects/${PROJECT_KEY}`);
      await page.getByRole("button", { name: /New task/ }).click();
      await expect(page.getByPlaceholder("Describe what you need")).toBeVisible();
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
