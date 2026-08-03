// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ExecutionPanel, elapsedLabel } from "./ExecutionPanel";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("elapsedLabel", () => {
  it("counts seconds under a minute", () => {
    expect(elapsedLabel(ago(42_000), NOW)).toBe("42s");
  });

  it("counts minutes under an hour", () => {
    expect(elapsedLabel(ago(9 * 60_000), NOW)).toBe("9m");
  });

  // The point of showing an age at all: a worker killed mid-run keeps its phase until the lease
  // expires, and the lease is only swept when a worker next polls that project. "4h 12m" is what
  // tells a reader the run is dead; rounding it to "a while ago" would hide exactly that.
  it("keeps hours and minutes apart once a run has been quiet for hours", () => {
    expect(elapsedLabel(ago(4 * 3_600_000 + 12 * 60_000), NOW)).toBe("4h 12m");
  });

  it("does not render a negative age from a clock that disagrees", () => {
    expect(elapsedLabel(new Date(NOW + 5_000).toISOString(), NOW)).toBe("just now");
  });

  it("says nothing about an unparseable timestamp", () => {
    expect(elapsedLabel("not a date", NOW)).toBe("");
  });
});

describe("ExecutionPanel", () => {
  afterEach(cleanup);

  it("shows the phase a run is in", () => {
    render(<ExecutionPanel execution={{ phase: "gates:build", workerId: "w-laptop" }} />);

    expect(screen.getByText("gates:build")).toBeTruthy();
    expect(screen.getByText(/w-laptop/)).toBeTruthy();
  });

  // A task that is not running has no phase field at all — task-service unsets the trio on every
  // exit from the active column — so an absent phase is current, never stale
  it("renders nothing at all when no run holds the task", () => {
    const { container } = render(<ExecutionPanel execution={{ workerId: "w-laptop" }} />);

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the task predates the execution subdocument", () => {
    const { container } = render(<ExecutionPanel />);

    expect(container.innerHTML).toBe("");
  });

  // lastError is only ever written as "", and attempts is decremented on refund so it counts
  // remaining budget rather than the attempt number. Neither may be rendered as if it meant
  // something.
  it("shows no attempt count and no last error, which would both be lies", () => {
    render(<ExecutionPanel execution={{ phase: "agent", workerId: "w-laptop" }} />);

    expect(screen.queryByText(/attempt/i)).toBeNull();
    expect(screen.queryByText(/error/i)).toBeNull();
  });
});
