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

  it("says a trial ended and that nothing was removed, with no grace period in it", () => {
    render(<LicenceDetails licence={valid({ verdict: "expired", trial: true, daysLeft: -1, graceEndsAt: "2027-01-01T00:00:00.000Z" })} />);

    expect(screen.getByTestId("licence-warning").textContent).toBe(
      "This trial ended on January 1, 2027, so this instance is on the Free plan. No data was removed, and a licence key restores the plan."
    );
    expect(screen.getByTestId("licence-warning").textContent).not.toMatch(/grace/);
    expect(row("Plan")).toBe("Pro (expired)");
  });

  it("tells a live trial it ends, and does not ask it to renew", () => {
    render(<LicenceDetails licence={valid({ trial: true, daysLeft: 20 })} />);

    expect(screen.getByTestId("licence-warning").textContent).toBe(
      "This trial ends in 20 days, on January 1, 2027. After that this instance is on the Free plan unless a licence key is set."
    );
    expect(screen.getByTestId("licence-warning").textContent).not.toMatch(/Renew/);
  });

  it("marks a live trial in the plan row", () => {
    render(<LicenceDetails licence={valid({ trial: true })} />);

    expect(row("Plan")).toBe("Pro (trial)");
  });

  // BP-983: the key of a subscription says whether it renews by itself or was cancelled
  describe("a subscription's key", () => {
    it("says nothing to renew while it renews by itself, however near its end", () => {
      const { container } = render(<LicenceDetails licence={valid({ subscription: "renewing", daysLeft: 3 })} />);

      expect(screen.queryByTestId("licence-warning")).toBeNull();
      expect(container.textContent).not.toMatch(/Renew it/);
    });

    it("says nothing on the day after its end, which is the renewal's to be paid, and a payment failed from the day after", () => {
      const settling = render(<LicenceDetails licence={valid({ verdict: "grace", subscription: "renewing", daysLeft: -1 })} />);
      expect(screen.queryByTestId("licence-warning")).toBeNull();
      settling.unmount();

      render(<LicenceDetails licence={valid({ verdict: "grace", subscription: "renewing", daysLeft: -2 })} />);
      expect(screen.getByTestId("licence-warning").textContent).toMatch(/^The last payment failed/);
    });

    it("says a payment failed, with the days that are left, when a renewing one has run past its end", () => {
      render(<LicenceDetails licence={valid({ verdict: "grace", subscription: "renewing", daysLeft: -2 })} />);

      expect(screen.getByTestId("licence-warning").textContent).toBe(
        "The last payment failed. The paid period ended on January 1, 2027; Pro stays on until January 15, 2027 while the payment is retried, then this organisation moves to the Free plan. No data is removed."
      );
    });

    it("says a cancelled one ends with its period and then Free, and when it has ended that it is Free with nothing removed", () => {
      const live = render(<LicenceDetails licence={valid({ subscription: "ending", daysLeft: 20 })} />);
      expect(screen.getByTestId("licence-warning").textContent).toBe("This subscription is cancelled: Pro ends on January 1, 2027, then this organisation is on the Free plan. No data is removed.");
      live.unmount();

      render(<LicenceDetails licence={valid({ verdict: "expired", subscription: "ending", daysLeft: -1, graceEndsAt: "2027-01-01T00:00:00.000Z" })} />);
      expect(screen.getByTestId("licence-warning").textContent).toBe(
        "This subscription ended on January 1, 2027, so this organisation is on the Free plan. No data was removed, and subscribing again restores the plan."
      );
      expect(screen.getByTestId("licence-warning").textContent).not.toMatch(/grace/);
    });
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
