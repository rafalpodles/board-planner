// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { agingNote, DeploymentsPanel, emptyTimeMessage, ScatterChart } from "./InsightsCharts";
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

describe("DeploymentsPanel", () => {
  const dora = sampleInsights(Date.UTC(2026, 9, 14)).dora;

  it("points to the GitHub settings when the board does not deploy from GitHub", () => {
    const { getByTestId } = render(<DeploymentsPanel dora={null} />);
    expect(getByTestId("insights-dora").textContent).toContain("Settings → Integrations");
  });

  it("says nothing was read yet before the first sync, and nothing finished after it", () => {
    const none = { ...dora, deployments: 0 };
    const first = render(<DeploymentsPanel dora={{ ...none, syncedThrough: null }} />);
    expect(first.getByTestId("insights-dora").textContent).toContain("have been read yet");
    cleanup();
    const later = render(<DeploymentsPanel dora={none} />);
    expect(later.getByTestId("insights-dora").textContent).toContain("No deployment to “production” finished in this window");
  });

  it("says when GitHub refused the listing or a rate limit holds, rather than that it is still asking", () => {
    const none = { ...dora, deployments: 0, syncedThrough: null };
    const refused = render(<DeploymentsPanel dora={{ ...none, lastError: "GitHub answered 403" }} />);
    expect(refused.getByTestId("insights-dora").textContent).toContain("needs read access to deployments");
    cleanup();
    const limited = render(<DeploymentsPanel dora={{ ...none, rateLimitedUntil: new Date(Date.UTC(2026, 9, 14, 13)).toISOString() }} />);
    expect(limited.getByTestId("insights-dora").textContent).toContain("rate limit was reached");
  });

  it("shows the four figures and a table of each week", () => {
    const { getByTestId } = render(
      <DeploymentsPanel
        dora={{
          ...dora,
          deployments: 4,
          deploymentsPerWeek: 1.5,
          changeFailureRate: 0.25,
          leadTimeForChanges: { count: 2, medianMs: 2 * 86_400_000, p85Ms: 3 * 86_400_000 },
          timeToRestore: { count: 1, medianMs: 5 * 3_600_000, p85Ms: 5 * 3_600_000 },
          unrestored: 1,
          successes: 3,
          restored: 1,
        }}
      />
    );
    const text = getByTestId("insights-dora-figures").textContent;
    expect(text).toContain("1.5 / week");
    expect(text).toContain("3 succeeded of 4 finished");
    expect(text).toContain("1 of 4 finished deployments failed");
    expect(text).toContain("median of 1 restored; 1 not yet");
    expect(text).toContain("2 d");
    expect(text).toContain("25%");
    expect(text).toContain("5 h");

  });
});
