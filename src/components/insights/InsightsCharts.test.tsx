// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { agingNote, ScatterChart } from "./InsightsCharts";
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
