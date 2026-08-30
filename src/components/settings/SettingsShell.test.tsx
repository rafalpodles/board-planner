// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";
import { SettingsShell, type SettingsNavGroup } from "./SettingsShell";

afterEach(cleanup);

const ROUTED: SettingsNavGroup[] = [
  { title: "Account", items: [
    { id: "profile", label: "Profile", href: "/settings/profile" },
    { id: "tokens", label: "API Tokens", href: "/settings/tokens" },
  ] },
  { title: "Administration", items: [{ id: "users", label: "Users", href: "/settings/users" }] },
];

const SELECTED: SettingsNavGroup[] = [
  { items: [
    { id: "general", label: "General" },
    { id: "board", label: "Board", dirty: true },
  ] },
];

// Both rows are always in the DOM — Tailwind decides which one the viewport shows — so the
// tests address them by which one they are rather than by their shared accessible name
const sidebar = () => document.querySelector('[data-settings-nav="sidebar"]')!;
const pills = () => document.querySelector('[data-settings-nav="pills"]')!;

describe("SettingsShell", () => {
  it("puts the page title in the one h1 and keeps the subtitle", () => {
    render(<SettingsShell title="Settings" subtitle="This account and this instance" groups={ROUTED} active="profile">body</SettingsShell>);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
    expect(screen.getByText("This account and this instance")).toBeTruthy();
  });

  it("renders a link per item when the surface navigates by route", () => {
    render(<SettingsShell groups={ROUTED} active="profile">body</SettingsShell>);
    const link = screen.getAllByRole("link", { name: "API Tokens" })[0] as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/settings/tokens");
  });

  it("renders a button per item when the surface switches in place", async () => {
    const onSelect = vi.fn();
    render(<SettingsShell groups={SELECTED} active="general" onSelect={onSelect}>body</SettingsShell>);
    const buttons = screen.getAllByRole("button", { name: /Board/ });
    expect(buttons.length).toBeGreaterThan(0);
    buttons[0].click();
    expect(onSelect).toHaveBeenCalledWith("board");
  });

  it("marks the active item in both the sidebar and the pill row", () => {
    const { container } = render(<SettingsShell groups={ROUTED} active="tokens">body</SettingsShell>);
    const current = [...container.querySelectorAll('[aria-current]')];
    expect(current.length).toBe(2);
    current.forEach((el) => expect(el.textContent).toContain("API Tokens"));
  });

  it("leaves the app's only <main> alone", () => {
    const { container } = render(<SettingsShell groups={ROUTED} active="profile">body</SettingsShell>);
    expect(container.querySelector("main")).toBe(null);
  });

  it("shows the group headings above their items", () => {
    render(<SettingsShell groups={ROUTED} active="profile">body</SettingsShell>);
    expect(sidebar().textContent).toContain("Account");
    expect(sidebar().textContent).toContain("Administration");
  });

  it("flags an item with unsaved work", () => {
    const { container } = render(<SettingsShell groups={SELECTED} active="general" onSelect={() => {}}>body</SettingsShell>);
    expect(container.querySelectorAll('[title="Unsaved changes"]').length).toBeGreaterThan(0);
  });

  /**
   * BP-498. The marker sits inside the item's own button, so its `title` folds into that button's
   * accessible name and a dirty section announced as "General Unsaved changes". The five markers
   * BP-450 fixed were spelled `title="Unsaved"`, which is why a grep for that string missed this
   * one — and `Select.test.tsx` has had exactly this assertion for its own marker since.
   *
   * The test above passes either way: it selects the dot by `title`, which `aria-hidden` does not
   * affect. This is the one that separates them.
   */
  it("keeps the unsaved marker out of the item's name", () => {
    const { container } = render(<SettingsShell groups={SELECTED} active="general" onSelect={() => {}}>body</SettingsShell>);

    const marker = container.querySelector('[title="Unsaved changes"]');
    expect(marker).not.toBeNull();
    expect(marker!.getAttribute("aria-hidden")).toBe("true");

    // The control, and what the reader actually hears: the button is still named for its section
    for (const button of container.querySelectorAll("button")) {
      if ((button.textContent ?? "").includes("General")) {
        expect(button.textContent?.replace(/\s+/g, " ").trim()).toBe("General");
      }
    }
  });

  it("renders the sidebar slots around the groups", () => {
    render(
      <SettingsShell groups={ROUTED} active="profile" sidebarTop={<input aria-label="Search settings" />} sidebarFooter={<p>Admin only</p>}>
        body
      </SettingsShell>
    );
    expect(sidebar().contains(screen.getByLabelText("Search settings"))).toBe(true);
    expect(sidebar().contains(screen.getByText("Admin only"))).toBe(true);
  });

  it("keeps every section in the pill row while the sidebar is filtered", () => {
    const all = SELECTED[0].items;
    render(
      <SettingsShell groups={[{ items: [all[0]] }]} pillItems={all} active="general" onSelect={() => {}}>
        body
      </SettingsShell>
    );
    expect(pills().textContent).toContain("Board");
    expect(sidebar().textContent).not.toContain("Board");
  });

  /**
   * The defect this component exists to prevent. BP-365 pinned the pill row on project
   * settings and left the account settings row scrolling away with the page, because the
   * two surfaces each wrote their own. One shell means one answer for both.
   */
  it("pins the mobile pill row against the top of the scrollport", () => {
    render(<SettingsShell groups={ROUTED} active="profile">body</SettingsShell>);
    const cls = pills().className;
    expect(cls).toContain("sticky");
    expect(cls).toContain("bg-bg");
    expect(cls).toContain("border-b");

    // The offset, the pull-out and the pay-back all cancel main's padding, so they are one
    // number in four places — changing one and missing the others is the way this breaks.
    // What the number has to *be* is main's own padding, which only the browser can measure:
    // `e2e/settings-mobile-nav.spec.ts`.
    const step = (pattern: RegExp) => cls.match(pattern)?.[1];
    const sizes = [step(/-top-(\d+)/), step(/-mx-(\d+)/), step(/-mt-(\d+)/), step(/ px-(\d+)/)];
    expect(sizes, cls).not.toContain(undefined);
    expect(new Set(sizes), cls).toHaveProperty("size", 1);
  });
});

// Whichever surface is added next inherits the fix instead of re-deciding it
describe("no settings surface builds its own nav", () => {
  const FILES = [
    "src/app/(app)/settings/layout.tsx",
    "src/app/(app)/projects/[projectId]/settings/page.tsx",
  ];

  it.each(FILES)("%s goes through SettingsShell", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(source).toContain("SettingsShell");
    expect(source).not.toContain("SectionPillsNav");
    expect(source).not.toContain("md:grid-cols-[");
  });
});
