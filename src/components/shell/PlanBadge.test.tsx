// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PlanBadge } from "./PlanBadge";

const { state } = vi.hoisted(() => ({
  state: { organisation: null as null | { plan: "free" | "pro"; planEndsAt: string | null; trial?: boolean }, isAdmin: true },
}));
vi.mock("@/hooks/use-organisation", () => ({ useOrganisation: () => ({ organisation: state.organisation }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isAdmin: state.isAdmin }) }));

const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

afterEach(() => {
  cleanup();
  state.isAdmin = true;
});

describe("PlanBadge (BP-930)", () => {
  it("renders nothing until the organisation is known", () => {
    state.organisation = null;
    render(<PlanBadge compact={false} />);
    expect(screen.queryByTestId("plan-badge")).toBeNull();
  });

  it("offers an administrator on Free the Upgrade button, and a member only the plan", () => {
    state.organisation = { plan: "free", planEndsAt: null };
    render(<PlanBadge compact={false} />);
    expect(screen.getByTestId("plan-badge-action")).toHaveProperty("textContent", "Upgrade");
    cleanup();

    state.isAdmin = false;
    render(<PlanBadge compact={false} />);
    expect(screen.getByTestId("plan-badge-detail").textContent).toBe("Free plan");
    expect(screen.queryByTestId("plan-badge-action")).toBeNull();
  });

  it("shows nothing to act on for a Pro plan with more than 30 days left", () => {
    state.organisation = { plan: "pro", planEndsAt: inDays(90) };
    render(<PlanBadge compact={false} />);
    expect(screen.getByTestId("plan-badge-detail").textContent).toBe("Plan active");
    expect(screen.queryByTestId("plan-badge-action")).toBeNull();
  });

  // BP-950: a trial is not renewed, it is upgraded from, and it never shows a grace period
  it("calls a trial a trial, counts its days and offers Upgrade, not Renew", () => {
    state.organisation = { plan: "pro", planEndsAt: inDays(20), trial: true };
    render(<PlanBadge compact={false} />);
    expect(screen.getByTestId("plan-badge").textContent).toMatch(/^Trial/);
    expect(screen.getByTestId("plan-badge-detail").textContent).toMatch(/^20 days left · /);
    expect(screen.getByTestId("plan-badge-action").textContent).toBe("Upgrade");
  });

  it("shows no grace for a trial whose end has passed on the viewer's clock", () => {
    state.organisation = { plan: "pro", planEndsAt: inDays(-0.01), trial: true };
    render(<PlanBadge compact={false} />);
    expect(screen.getByTestId("plan-badge-detail").textContent).toBe("Free plan");
    expect(screen.queryByText(/until /)).toBeNull();
  });

  it("counts the days and offers Renew when Pro ends within 30 days", () => {
    state.organisation = { plan: "pro", planEndsAt: inDays(12) };
    render(<PlanBadge compact={false} />);
    expect(screen.getByTestId("plan-badge-detail").textContent).toMatch(/^12 days left · /);
    expect(screen.getByTestId("plan-badge-action").textContent).toBe("Renew");
  });

  it("says the licence is in its grace period and until when", () => {
    state.organisation = { plan: "pro", planEndsAt: inDays(-3) };
    render(<PlanBadge compact={false} />);
    expect(screen.getByTestId("plan-badge-detail").textContent).toMatch(/^Ended .* · until /);
    expect(screen.getByTestId("plan-badge-action").textContent).toBe("Renew");
  });

  it("in a collapsed sidebar shows the plan name with the full sentence as its title", () => {
    state.organisation = { plan: "pro", planEndsAt: inDays(5) };
    render(<PlanBadge compact />);
    const badge = screen.getByTestId("plan-badge");
    expect(badge.textContent).toBe("Pro");
    expect(badge.getAttribute("title")).toMatch(/^Pro plan, ends /);
    expect(badge.getAttribute("aria-label")).toBe(badge.getAttribute("title"));
    expect(badge.getAttribute("href")).toBe("/settings/licence");
  });

  it("in a collapsed sidebar a member is never sent to the licence page", () => {
    state.isAdmin = false;
    state.organisation = { plan: "free", planEndsAt: null };
    render(<PlanBadge compact />);
    expect(screen.getByTestId("plan-badge").getAttribute("href")).toBe("/settings/organisation");
  });
});
