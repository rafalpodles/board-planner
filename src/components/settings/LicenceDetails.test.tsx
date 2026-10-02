// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LicenceDetails, type LicenceSummary } from "./LicenceDetails";

afterEach(cleanup);

function valid(overrides: Partial<Extract<LicenceSummary, { customer: string }>> = {}): LicenceSummary {
  return {
    configured: true,
    verdict: "valid",
    customer: "Acme Ltd",
    plan: "pro",
    features: [],
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    graceEndsAt: "2027-01-15T00:00:00.000Z",
    daysLeft: 200,
    graceDaysLeft: 214,
    keyId: "bp-2026-10",
    ...overrides,
  };
}

function row(label: string): string | null {
  const term = screen.getByText(label, { selector: "dt" });
  return term.nextElementSibling?.textContent ?? null;
}

function noEditableControl(container: HTMLElement) {
  expect(container.querySelectorAll("input, textarea, select, button, [contenteditable]")).toHaveLength(0);
}

describe("LicenceDetails", () => {
  it("shows the Free plan and where to get a licence when no key is set", () => {
    const { container } = render(<LicenceDetails licence={{ configured: false }} />);

    expect(screen.getByText("Free plan")).toBeTruthy();
    expect(screen.getByRole("link", { name: "How to get one" }).getAttribute("href")).toContain("#licence-key");
    expect(screen.queryByRole("alert")).toBeNull();
    noEditableControl(container);
  });

  it.each([
    ["unknown_key", "signed by a key this build does not know"],
    ["invalid_signature", "its signature does not match its contents"],
    ["malformed", "is not a licence key"],
  ] as const)("names %s and stays on the Free plan", (verdict, words) => {
    render(<LicenceDetails licence={{ configured: true, verdict }} />);

    expect(screen.getByText("Free plan")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(words);
  });

  it("lists customer, plan, features, dates and days left for a valid key", () => {
    const { container } = render(<LicenceDetails licence={valid()} />);

    expect(row("Customer")).toBe("Acme Ltd");
    expect(row("Plan")).toBe("Pro");
    expect(row("Features")).toBe("All");
    expect(row("Expires")).toContain("2027");
    expect(row("Days left")).toBe("200");
    expect(screen.queryByTestId("licence-warning")).toBeNull();
    noEditableControl(container);
  });

  it("warns from 30 days before expiry, and not at 31", () => {
    render(<LicenceDetails licence={valid({ daysLeft: 31 })} />);
    expect(screen.queryByTestId("licence-warning")).toBeNull();
    cleanup();

    render(<LicenceDetails licence={valid({ daysLeft: 30 })} />);
    expect(screen.getByTestId("licence-warning").textContent).toContain("expires in 30 days");
  });

  it("says Pro stays on, and until when, during the grace period", () => {
    render(<LicenceDetails licence={valid({ verdict: "grace", daysLeft: -3, graceDaysLeft: 11 })} />);

    expect(screen.getByRole("alert").textContent).toContain("stay on for 11 days");
    expect(row("Days left")).toBe("0");
  });

  it("says the instance is on Free once the grace period is over", () => {
    render(<LicenceDetails licence={valid({ verdict: "expired", daysLeft: -20, graceDaysLeft: -6 })} />);

    expect(screen.getByRole("alert").textContent).toContain("on the Free plan");
    expect(row("Plan")).toBe("Pro (expired)");
  });
});
