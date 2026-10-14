// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { agingNote, emptyTimeMessage, ScatterChart } from "./InsightsCharts";
import { sampleInsights } from "./sample";

afterEach(cleanup);

describe("agingNote", () => {
  it("says what share of finished tasks took less, and says all of them rather than 100%", () => {
    expect(agingNote(48)).toBe("Running longer than 48% of finished tasks took");
    expect(agingNote(100)).toBe("Running longer than any finished task took");
  });
});

describe("ScatterChart", () => {
  it("moves the median's label below its line when it would print over the 85th percentile's", () => {
    const insights = sampleInsights(Date.UTC(2026, 9, 14));
    const close = { ...insights, summary: { ...insights.summary, cycleTime: { count: 9, medianMs: 1_000, p85Ms: 1_100 } } };

    const { container } = render(<ScatterChart insights={close} measure="cycleTime" projectRef="DEMO" />);
    const labels = [...container.querySelectorAll("text")].filter((t) => /^(50|85)%/.test(t.textContent ?? ""));
    const [median, p85] = ["50%", "85%"].map((p) => Number(labels.find((t) => t.textContent!.startsWith(p))!.getAttribute("y")));

    expect(Math.abs(median - p85)).toBeGreaterThanOrEqual(14);
  });
});

describe("emptyTimeMessage", () => {
  const base = sampleInsights(Date.UTC(2026, 9, 14));

  it("says finished tasks had no start when they finished without a cycle time", () => {
    const noStarts = { ...base, summary: { ...base.summary, cycleTime: null } };

    expect(emptyTimeMessage(noStarts, "cycleTime", "fallback")).toContain("No finished task has a recorded start");
    expect(emptyTimeMessage(noStarts, "leadTime", "fallback")).toBe("fallback");
  });

  it("keeps the plain message when nothing finished", () => {
    const nothing = { ...base, summary: { throughput: 0, leadTime: null, cycleTime: null } };

    expect(emptyTimeMessage(nothing, "cycleTime", "fallback")).toBe("fallback");
  });
});
