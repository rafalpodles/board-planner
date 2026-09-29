// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { mailUnavailable, NotificationMatrixEditor } from "./NotificationMatrix";
import { NOTIFICATION_TYPES, NotificationMatrix } from "@/types";

const grid = Object.fromEntries(
  NOTIFICATION_TYPES.map((t) => [t, { inApp: false, email: true, chat: false }])
) as NotificationMatrix;

const column = (label: string) =>
  screen
    .getAllByRole("checkbox")
    .filter((box) => box.getAttribute("aria-label")!.endsWith(label)) as HTMLInputElement[];

afterEach(cleanup);

// BP-735. The e-mail column used to take a tick on an instance with no mail server, and on an
// account with no address, where it silently delivered nothing — the chat column already refused.
describe("the e-mail column", () => {
  it("is open when mail can be sent", () => {
    render(<NotificationMatrixEditor value={grid} onChange={vi.fn()} />);

    expect(column("— E-mail").every((box) => !box.disabled)).toBe(true);
    expect(column("— E-mail").every((box) => !box.hasAttribute("aria-describedby"))).toBe(true);
    expect(screen.queryByText("unavailable")).toBeNull();
  });

  it("is closed, and each cell is described by the reason, when there is no mail server", () => {
    render(<NotificationMatrixEditor value={grid} onChange={vi.fn()} emailUnavailable="server" />);

    const hint = screen.getByText(/no mail server/);
    expect(hint.textContent).toBe(
      "This instance has no mail server, so e-mail and the daily digest are off — ask an administrator."
    );
    expect(column("— E-mail").every((box) => box.disabled)).toBe(true);
    // What was ticked stays on screen: the stored grid is not rewritten by being unreachable
    expect(column("— E-mail").every((box) => box.checked)).toBe(true);
    expect(column("— E-mail").every((box) => box.getAttribute("aria-describedby") === hint.id)).toBe(true);
    expect(column("— In app").every((box) => !box.disabled)).toBe(true);
    expect(screen.getByText("unavailable")).toBeTruthy();
  });

  it("points an account with no address at its profile", () => {
    render(<NotificationMatrixEditor value={grid} onChange={vi.fn()} emailUnavailable="address" />);

    const link = screen.getByRole("link", { name: "your profile" });
    expect(link.getAttribute("href")).toBe("/settings/profile");
    expect(link.parentElement!.textContent).toBe(
      "Add an e-mail address to your profile to get these and the daily digest by e-mail."
    );
  });

  // A board's own grid has no digest box beside it, so the reason does not mention one
  it("leaves the digest out of the reason on a board's own grid", () => {
    const { rerender } = render(
      <NotificationMatrixEditor value={grid} onChange={vi.fn()} emailUnavailable="server" scope="project" />
    );
    expect(screen.getByText(/no mail server/).textContent).toBe(
      "This instance has no mail server, so e-mail is off — ask an administrator."
    );

    rerender(
      <NotificationMatrixEditor value={grid} onChange={vi.fn()} emailUnavailable="address" scope="project" />
    );
    expect(screen.getByRole("link", { name: "your profile" }).parentElement!.textContent).toBe(
      "Add an e-mail address to your profile to get these by e-mail."
    );
  });

  it("describes a control outside the grid by the id it was handed", () => {
    render(
      <NotificationMatrixEditor
        value={grid}
        onChange={vi.fn()}
        emailUnavailable="server"
        emailHintId="digest-reason"
      />
    );

    expect(screen.getByText(/no mail server/).id).toBe("digest-reason");
    expect(column("— E-mail")[0].getAttribute("aria-describedby")).toBe("digest-reason");
  });
});

describe("the chat column's reason", () => {
  it("describes the closed chat cells", () => {
    render(
      <NotificationMatrixEditor value={grid} onChange={vi.fn()} chatDisabled chatDisabledHint="Connect first." />
    );

    const hint = screen.getByText("Connect first.");
    expect(column("— Chat").every((box) => box.getAttribute("aria-describedby") === hint.id)).toBe(true);
  });
});

describe("mailUnavailable", () => {
  it("names the missing mail server first, then the missing address", () => {
    expect(mailUnavailable({ server: false, address: false })).toBe("server");
    expect(mailUnavailable({ server: false, address: true })).toBe("server");
    expect(mailUnavailable({ server: true, address: false })).toBe("address");
    expect(mailUnavailable({ server: true, address: true })).toBeUndefined();
  });

  // An answer from before the field existed leaves the column as it always was
  it("says nothing when the server did not say", () => {
    expect(mailUnavailable(undefined)).toBeUndefined();
  });
});
