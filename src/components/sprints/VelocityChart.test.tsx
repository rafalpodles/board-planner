// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { VelocityChart } from "./VelocityChart";
import { ApiSprint } from "@/types";

function sprint(over: Partial<ApiSprint> & { _id: string }): ApiSprint {
  return {
    project: "p1",
    name: over._id,
    startDate: "2026-01-01T00:00:00Z",
    endDate: "2026-01-15T00:00:00Z",
    goal: "",
    status: "completed",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  } as ApiSprint;
}

// Deliberately out of chronological order, so a component that trusts array order
// rather than sorting would fail every ordering assertion below.
const threeCompleted: ApiSprint[] = [
  sprint({ _id: "c", name: "Sprint 12", startDate: "2026-03-01T00:00:00Z", estimateDone: 20 }),
  sprint({ _id: "a", name: "Sprint 10", startDate: "2026-01-01T00:00:00Z", estimateDone: 13 }),
  sprint({ _id: "b", name: "Sprint 11", startDate: "2026-02-01T00:00:00Z", estimateDone: 8 }),
];

const oneCompleted: ApiSprint[] = [
  sprint({ _id: "a", name: "Sprint 10", startDate: "2026-01-01T00:00:00Z", estimateDone: 13 }),
];

afterEach(cleanup);

describe("VelocityChart", () => {
  it("plots one bar per completed sprint, oldest first", () => {
    const { container } = render(<VelocityChart sprints={threeCompleted} />);
    expect(container.querySelectorAll("svg")).toHaveLength(3);
  });

  it("orders bars oldest to newest regardless of input order", () => {
    render(<VelocityChart sprints={threeCompleted} />);
    const names = screen.getAllByText(/^Sprint \d+$/);
    expect(names.map((n) => n.textContent)).toEqual(["Sprint 10", "Sprint 11", "Sprint 12"]);
  });

  it("says there is not enough history rather than drawing an empty frame", () => {
    render(<VelocityChart sprints={oneCompleted} />);
    expect(screen.getByText(/two completed sprints/i)).toBeTruthy();
    expect(document.querySelector("svg")).toBeNull();
  });

  it("renders nothing at all with no completed sprints", () => {
    const { container } = render(<VelocityChart sprints={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when every sprint is planned or active", () => {
    const { container } = render(
      <VelocityChart
        sprints={[sprint({ _id: "p", status: "planned" }), sprint({ _id: "act", status: "active" })]}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("labels each bar with its sprint and completed estimate", () => {
    render(<VelocityChart sprints={threeCompleted} />);
    expect(screen.getByText("Sprint 10")).toBeTruthy();
    expect(screen.getByText("13")).toBeTruthy();
  });

  it("shows the chart, not the sentence, at exactly two completed sprints", () => {
    const { container } = render(<VelocityChart sprints={threeCompleted.slice(0, 2)} />);
    expect(screen.getAllByRole("img", { hidden: true })).toHaveLength(1);
    expect(container.querySelectorAll("svg")).toHaveLength(2);
    expect(screen.queryByText(/two completed sprints/i)).toBeNull();
  });

  it("scales bar height to the largest completed estimate in the set", () => {
    const scaled: ApiSprint[] = [
      sprint({ _id: "x", name: "Sprint A", startDate: "2026-01-01T00:00:00Z", estimateDone: 4 }),
      sprint({ _id: "y", name: "Sprint B", startDate: "2026-02-01T00:00:00Z", estimateDone: 16 }),
      sprint({ _id: "z", name: "Sprint C", startDate: "2026-03-01T00:00:00Z", estimateDone: 8 }),
    ];
    const { container } = render(<VelocityChart sprints={scaled} />);
    const heights = Array.from(container.querySelectorAll("rect")).map((r) =>
      Number(r.getAttribute("height"))
    );
    expect(heights[1]).toBeGreaterThan(heights[0]);
    expect(heights[2]).toBeGreaterThan(heights[0]);
    expect(heights[2]).toBeLessThan(heights[1]);
    expect(Math.max(...heights)).toBe(heights[1]);
  });

  it("treats a missing estimateDone as zero rather than crashing or omitting the bar", () => {
    const withGap: ApiSprint[] = [
      sprint({ _id: "x", name: "Sprint A", startDate: "2026-01-01T00:00:00Z", estimateDone: 10 }),
      sprint({ _id: "y", name: "Sprint B", startDate: "2026-02-01T00:00:00Z", estimateDone: undefined }),
    ];
    const { container } = render(<VelocityChart sprints={withGap} />);
    expect(container.querySelectorAll("svg")).toHaveLength(2);
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("ignores sprints outside completed status when picking the set to plot", () => {
    const mixed: ApiSprint[] = [
      ...threeCompleted,
      sprint({ _id: "d", name: "Sprint 13", status: "active", estimateDone: 999 }),
      sprint({ _id: "e", name: "Sprint 9", status: "planned" }),
    ];
    const { container } = render(<VelocityChart sprints={mixed} />);
    expect(container.querySelectorAll("svg")).toHaveLength(3);
    expect(screen.queryByText("Sprint 13")).toBeNull();
  });

  it("explains there is no total yet rather than drawing an empty band, when every completed sprint scored zero", () => {
    const allZero: ApiSprint[] = [
      sprint({ _id: "a", name: "Sprint 10", startDate: "2026-01-01T00:00:00Z", estimateDone: 0 }),
      sprint({ _id: "b", name: "Sprint 11", startDate: "2026-02-01T00:00:00Z" }),
    ];
    render(<VelocityChart sprints={allZero} />);
    expect(screen.getByRole("heading", { name: "Velocity" })).toBeTruthy();
    expect(screen.queryAllByRole("img", { hidden: true })).toHaveLength(0);
    expect(screen.queryByText("0")).toBeNull();
  });

  it("scales the tallest bar to the full track even when every total is under one", () => {
    const fractional: ApiSprint[] = [
      sprint({ _id: "x", name: "Sprint A", startDate: "2026-01-01T00:00:00Z", estimateDone: 0.5 }),
      sprint({ _id: "y", name: "Sprint B", startDate: "2026-02-01T00:00:00Z", estimateDone: 0.25 }),
    ];
    const { container } = render(<VelocityChart sprints={fractional} />);
    const heights = Array.from(container.querySelectorAll("rect")).map((r) =>
      Number(r.getAttribute("height"))
    );
    expect(heights[0]).toBe(96);
    expect(heights[1]).toBe(48);
  });

  it("treats a negative total as zero rather than pairing an empty bar with a negative label", () => {
    const negative: ApiSprint[] = [
      sprint({ _id: "x", name: "Sprint A", startDate: "2026-01-01T00:00:00Z", estimateDone: 8 }),
      sprint({ _id: "y", name: "Sprint B", startDate: "2026-02-01T00:00:00Z", estimateDone: -5 }),
    ];
    const { container } = render(<VelocityChart sprints={negative} />);
    expect(container.querySelectorAll("svg")).toHaveLength(2);
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.queryByText("-5")).toBeNull();
  });

  it("rounds a floating-point sum for display instead of printing every trailing digit", () => {
    const imprecise: ApiSprint[] = [
      sprint({ _id: "x", name: "Sprint A", startDate: "2026-01-01T00:00:00Z", estimateDone: 8 }),
      sprint({ _id: "y", name: "Sprint B", startDate: "2026-02-01T00:00:00Z", estimateDone: 0.6000000000000001 }),
    ];
    render(<VelocityChart sprints={imprecise} />);
    expect(screen.getByText("0.6")).toBeTruthy();
  });

  it("gives the whole chart one accessible description that carries every sprint's value", () => {
    const { container } = render(<VelocityChart sprints={threeCompleted} />);
    const images = screen.getAllByRole("img", { hidden: true });
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute("aria-label")).toBe(
      "Velocity across completed sprints: Sprint 10 13, Sprint 11 8, Sprint 12 20"
    );
    expect(images[0].querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("svg")).toHaveLength(3);
  });

  it("does not let individual bars announce themselves, since the chart-level description already carries their values", () => {
    const { container } = render(<VelocityChart sprints={threeCompleted} />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThan(0);
    svgs.forEach((svg) => {
      expect(svg.getAttribute("role")).toBeNull();
      expect(svg.getAttribute("aria-label")).toBeNull();
    });
  });

  it("caps the drawn bar's width but leaves the column free to size to the layout", () => {
    const { container } = render(<VelocityChart sprints={threeCompleted.slice(0, 2)} />);
    const svgs = Array.from(container.querySelectorAll("svg"));
    expect(svgs).toHaveLength(2);
    svgs.forEach((svg) => {
      expect(Number.parseInt(svg.style.maxWidth, 10)).toBeGreaterThan(0);
      const column = svg.parentElement as HTMLElement;
      expect(column.style.maxWidth).toBe("");
    });
  });

  it("puts the full sprint name in a title attribute so a truncated label is recoverable on hover", () => {
    render(<VelocityChart sprints={threeCompleted} />);
    const label = screen.getByText("Sprint 10");
    expect(label.getAttribute("title")).toBe("Sprint 10");
  });
});
