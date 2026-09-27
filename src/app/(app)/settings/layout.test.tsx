// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import SettingsLayout from "./layout";

const { nav, auth } = vi.hoisted(() => ({
  nav: { pathname: "/settings/profile" },
  auth: { isAdmin: false },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));

function shown(pathname: string, isAdmin = false) {
  nav.pathname = pathname;
  auth.isAdmin = isAdmin;
  render(
    <SettingsLayout>
      <p>page</p>
    </SettingsLayout>
  );
}

const current = () =>
  screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

// BP-761. A member's machines had no page of their own: the only list was the fleet console
describe("the settings nav", () => {
  it("offers every signed-in person their own machines", () => {
    shown("/settings/profile");

    const links = screen.getAllByRole("link", { name: "Machines" });
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => link.getAttribute("href") === "/settings/machines")).toBe(true);
    expect(screen.queryByRole("link", { name: "Workers" })).toBeNull();
  });

  it("marks Machines while a member is on one of their machine's projects", () => {
    shown("/settings/workers/6a7309535eb49af333b85a04/projects");

    expect(current().map((link) => link.textContent)).toEqual(
      current().map(() => "Machines")
    );
    expect(current().length).toBeGreaterThan(0);
  });

  it("keeps Workers marked for an instance admin, whose way in is the fleet console", () => {
    shown("/settings/workers/6a7309535eb49af333b85a04/projects", true);

    expect(current().length).toBeGreaterThan(0);
    expect(current().every((link) => link.textContent === "Workers")).toBe(true);
  });
});
