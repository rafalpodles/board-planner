// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { emailUnavailableHint, NotificationMatrixEditor } from "./NotificationMatrix";
import { NOTIFICATION_TYPES, NotificationMatrix } from "@/types";

const grid = Object.fromEntries(
  NOTIFICATION_TYPES.map((t) => [t, { inApp: false, email: true, chat: false }])
) as NotificationMatrix;

const column = (label: string) =>
  screen.getAllByRole("checkbox").filter((box) => box.getAttribute("aria-label")!.endsWith(label)) as HTMLInputElement[];

afterEach(cleanup);

// BP-735. The e-mail column used to take a tick on an instance with no mail server, and on an
// account with no address, where it silently delivered nothing — the chat column already refused.
describe("the e-mail column", () => {
  it("is open when mail can be sent", () => {
    render(<NotificationMatrixEditor value={grid} onChange={vi.fn()} />);

    expect(column("— E-mail").every((box) => !box.disabled)).toBe(true);
    expect(screen.queryByText("unavailable")).toBeNull();
  });

  it("is closed, and says why, when it cannot", () => {
    const hint = "This instance has no mail server, so nothing can be sent by e-mail.";
    render(
      <NotificationMatrixEditor value={grid} onChange={vi.fn()} emailDisabled emailDisabledHint={hint} />
    );

    expect(column("— E-mail").every((box) => box.disabled)).toBe(true);
    // What was ticked stays on screen: the stored grid is not rewritten by being unreachable
    expect(column("— E-mail").every((box) => box.checked)).toBe(true);
    expect(column("— In app").every((box) => !box.disabled)).toBe(true);
    expect(screen.getByText("unavailable")).toBeTruthy();
    expect(screen.getByText(hint)).toBeTruthy();
  });
});

describe("emailUnavailableHint", () => {
  it("names the missing mail server first, then the missing address", () => {
    expect(emailUnavailableHint({ server: false, address: false })).toMatch(/no mail server/);
    expect(emailUnavailableHint({ server: false, address: true })).toMatch(/no mail server/);
    expect(emailUnavailableHint({ server: true, address: false })).toMatch(/e-mail address/);
    expect(emailUnavailableHint({ server: true, address: true })).toBeUndefined();
  });

  // An answer from before the field existed leaves the column as it always was
  it("says nothing when the server did not say", () => {
    expect(emailUnavailableHint(undefined)).toBeUndefined();
  });
});
