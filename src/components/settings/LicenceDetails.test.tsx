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
    expect(screen.getByRole("link", { name: "About licences" }).getAttribute("href")).toContain("#licence-key");
    expect(screen.queryByRole("alert")).toBeNull();
    noEditableControl(container);
  });

  it.each([
    ["unknown_key", "signed by a key this build does not know"],
    ["invalid_signature", "its signature does not match its contents"],
    ["malformed", "is not a licence key"],
    ["wrong_organisation", "issued for another organisation"],
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
    expect(row("Issued")).toBe("January 1, 2026");
    expect(row("Expires")).toBe("January 1, 2027");
    expect(row("Days left")).toBe("200");
    expect(screen.queryByTestId("licence-warning")).toBeNull();
    noEditableControl(container);
  });

  it("warns from 30 days before expiry, and not at 31", () => {
    render(<LicenceDetails licence={valid({ daysLeft: 31 })} />);
    expect(screen.queryByTestId("licence-warning")).toBeNull();
    cleanup();

    render(<LicenceDetails licence={valid({ daysLeft: 30 })} />);
    expect(screen.getByTestId("licence-warning").textContent).toBe(
      "This licence expires in 30 days, on January 1, 2027. Renew it before then."
    );
  });

  it("reads the expiry as the UTC day it was signed for, wherever the viewer is", () => {
    render(
      <LicenceDetails
        licence={valid({ expiresAt: "2027-10-02T23:59:59.999Z", graceEndsAt: "2027-10-16T23:59:59.999Z", daysLeft: 5 })}
      />
    );

    expect(row("Expires")).toBe("October 2, 2027");
    expect(screen.getByTestId("licence-warning").textContent).toContain("on October 2, 2027.");
  });

  it("names the expiry and the end of the grace period while in it", () => {
    render(<LicenceDetails licence={valid({ verdict: "grace", daysLeft: -3 })} />);

    expect(screen.getByRole("alert").textContent).toBe(
      "This licence expired on January 1, 2027. It stays in force until January 15, 2027, then this instance moves to the Free plan. No data is removed."
    );
    expect(row("Days left")).toBe("0");
  });

  it("says the instance is on Free once the grace period is over", () => {
    render(<LicenceDetails licence={valid({ verdict: "expired", daysLeft: -20 })} />);

    expect(screen.getByRole("alert").textContent).toBe(
      "This licence expired on January 1, 2027 and its grace period ended on January 15, 2027, so this instance is on the Free plan. No data was removed, and a renewed key restores the licence."
    );
    expect(row("Plan")).toBe("Pro (expired)");
  });

  it.each([
    [1, "expires tomorrow, on January 1, 2027."],
    [0, "expires today, on January 1, 2027."],
  ])("says %i days left in words", (daysLeft, words) => {
    render(<LicenceDetails licence={valid({ daysLeft })} />);

    expect(screen.getByTestId("licence-warning").textContent).toContain(words);
  });
});
