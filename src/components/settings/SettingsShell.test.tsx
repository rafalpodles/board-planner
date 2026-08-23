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
    // main is `px-4 py-6`, and a sticky offset is measured from the scrollport's content box
    expect(cls).toContain("-top-6");
    expect(cls).toContain("bg-bg");
    expect(cls).toContain("border-b");
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
