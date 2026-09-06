// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ExecutionPanel, ageAt, durationLabel } from "./ExecutionPanel";

const SERVER_NOW = "2026-08-03T12:00:00.000Z";
const before = (ms: number) => new Date(Date.parse(SERVER_NOW) - ms).toISOString();

function payload(overrides: Record<string, unknown> = {}) {
  return {
    workerId: "w-laptop",
    phase: "gates:build",
    phaseAt: before(12_000),
    startedAt: before(55 * 60_000),
    asOf: SERVER_NOW,
    runId: "run-1",
    phaseSeq: 7,
    attempts: 2,
    lastError: "",
    ...overrides,
  };
}

afterEach(cleanup);

describe("durationLabel", () => {
  it("counts seconds, minutes, then hours and minutes apart", () => {
    expect(durationLabel(42_000)).toBe("42s");
    expect(durationLabel(9 * 60_000)).toBe("9m");
    expect(durationLabel(4 * 3_600_000 + 12 * 60_000)).toBe("4h 12m");
  });

  it("says nothing rather than something nonsensical for an impossible duration", () => {
    expect(durationLabel(-5_000)).toBe("");
    expect(durationLabel(NaN)).toBe("");
  });
});

describe("ageAt", () => {
  it("measures against the server's clock, not the reader's", () => {
    expect(ageAt(before(30_000), SERVER_NOW, 0)).toBe(30_000);
  });

  it("advances by the time elapsed since the page received it", () => {
    expect(ageAt(before(30_000), SERVER_NOW, 4_000)).toBe(34_000);
  });

  it("never reports a negative age from timestamps that disagree", () => {
    expect(ageAt(new Date(Date.parse(SERVER_NOW) + 9_000).toISOString(), SERVER_NOW, 0)).toBe(0);
  });

  it("reports nothing for an unparseable or absent instant", () => {
    expect(ageAt("not a date", SERVER_NOW, 0)).toBeNaN();
    expect(ageAt(null, SERVER_NOW, 0)).toBeNaN();
    expect(ageAt(before(1_000), undefined, 0)).toBeNaN();
  });
});

describe("ExecutionPanel", () => {
  it("shows the phase, and keeps time-spent apart from time-since-last-sign-of-life", () => {
    render(<ExecutionPanel execution={payload()} />);

    expect(screen.getByText("gates:build")).toBeTruthy();
    expect(screen.getByText(/running 55m/)).toBeTruthy();
    expect(screen.getByText(/last sign of life 12s ago/)).toBeTruthy();
  });

  it("renders no attempt count and no last error, though the wire carries both", () => {
    const { container } = render(<ExecutionPanel execution={payload()} />);

    expect(screen.queryByText(/attempt/i)).toBeNull();
    expect(screen.queryByText(/error/i)).toBeNull();
  });

  it("keeps the run identity out of the page", () => {
    const { container } = render(<ExecutionPanel execution={payload()} />);

    expect(container.textContent).not.toContain("run-1");
  });

  it("shows a live run as live", () => {
    const { container } = render(<ExecutionPanel execution={payload({ phaseAt: before(3_000) })} />);

    expect(container.querySelector('[data-testid="run-live"]')).toBeTruthy();
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("stops claiming a run is alive once it has gone quiet", () => {
    const { container } = render(<ExecutionPanel execution={payload({ phaseAt: before(20 * 60_000) })} />);

    expect(container.querySelector('[data-testid="run-quiet"]')).toBeTruthy();
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(container.querySelector(".bg-warning")).toBeTruthy();
  });

  it("shows a claimed run that has not reported a phase yet", () => {
    render(<ExecutionPanel execution={payload({ phase: undefined, phaseAt: null })} />);

    expect(screen.getByText("starting")).toBeTruthy();
  });

  it("renders nothing at all when no run holds the task", () => {
    const { container } = render(<ExecutionPanel execution={{ phaseAt: null, startedAt: null }} />);

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the task predates the execution subdocument", () => {
    const { container } = render(<ExecutionPanel />);

    expect(container.innerHTML).toBe("");
  });
});

describe("naming the machine", () => {
  it("shows the worker's name when the API resolved one", () => {
    const { container } = render(<ExecutionPanel execution={payload({ workerName: "rig-laptop" })} />);

    expect(screen.getByText(/rig-laptop/)).toBeTruthy();
    expect(container.textContent).not.toContain("w-laptop");
  });

  it("falls back to the id when no name came back", () => {
    render(<ExecutionPanel execution={payload()} />);

    expect(screen.getByText(/w-laptop/)).toBeTruthy();
  });
});
