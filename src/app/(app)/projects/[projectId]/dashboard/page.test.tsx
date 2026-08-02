// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import DashboardPage from "./page";

const { api } = vi.hoisted(() => ({ api: { get: vi.fn() } }));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const weeks = ["Jun 1", "Jun 8", "Jun 15", "Jun 22", "Jun 29", "Jul 6", "Jul 13", "Jul 20"];

interface Stats {
  total: number;
  done: number;
  statusBreakdown: Record<string, number>;
  categoryBreakdown: Record<string, number>;
  assigneeBreakdown: Record<string, number>;
  difficultyBreakdown: Record<string, number>;
  velocity: { week: string; count: number }[];
  createdOverTime: { week: string; created: number; completed: number }[];
}

const emptyStats: Stats = {
  total: 4,
  done: 0,
  statusBreakdown: { todo: 4 },
  categoryBreakdown: { bug: 4 },
  assigneeBreakdown: { rpo: 4 },
  difficultyBreakdown: { M: 4 },
  velocity: weeks.map((week) => ({ week, count: 0 })),
  createdOverTime: weeks.map((week) => ({ week, created: 0, completed: 0 })),
};

async function renderDashboard(stats: Partial<Stats> = {}) {
  api.get.mockImplementation((url: string) =>
    url.endsWith("/stats")
      ? Promise.resolve({ ...emptyStats, ...stats })
      : Promise.resolve({ name: "ClaudePlanner" })
  );
  const view = render(<DashboardPage />);
  await screen.findByRole("heading", { name: /Dashboard/ });
  return view;
}

function panel(title: string) {
  return within(screen.getByRole("heading", { name: title }).closest("div")!);
}

beforeEach(() => {
  api.get.mockReset();
});
afterEach(cleanup);

describe("Dashboard charts with no data", () => {
  it("explains what would fill the velocity chart instead of drawing bare axes", async () => {
    await renderDashboard();
    expect(screen.getByText(/each week a task reaches Done adds a bar/i)).toBeTruthy();
    expect(screen.queryByText("Last 8 weeks")).toBeNull();
  });

  it("explains what would fill created vs completed", async () => {
    await renderDashboard();
    const chart = panel("Created vs Completed");
    expect(chart.getByText(/new and finished tasks show up here/i)).toBeTruthy();
    expect(chart.queryByText("Created")).toBeNull();
  });

  it("drops the week labels so no chart is left as marks-free axes", async () => {
    await renderDashboard();
    expect(screen.queryByText("Jul 20")).toBeNull();
  });

  it("explains every breakdown that has nothing to show", async () => {
    await renderDashboard({ statusBreakdown: {}, categoryBreakdown: {}, assigneeBreakdown: {} });
    expect(screen.getByText(/every task counts towards its column here/i)).toBeTruthy();
    expect(screen.getByText(/categories appear as soon as the board has tasks/i)).toBeTruthy();
    expect(screen.getByText(/assign a task to see the split per person/i)).toBeTruthy();
  });
});

describe("Dashboard charts with partial data", () => {
  it("draws the velocity bars when a single week has a completion", async () => {
    await renderDashboard({
      velocity: weeks.map((week, i) => ({ week, count: i === 7 ? 3 : 0 })),
    });
    expect(screen.queryByText(/each week a task reaches Done adds a bar/i)).toBeNull();
    expect(screen.getByText("Last 8 weeks")).toBeTruthy();
    expect(screen.getAllByText("Jul 20").length).toBeGreaterThan(0);
  });

  it("draws created vs completed when only tasks were created", async () => {
    await renderDashboard({
      createdOverTime: weeks.map((week, i) => ({ week, created: i === 0 ? 2 : 0, completed: 0 })),
    });
    const chart = panel("Created vs Completed");
    expect(chart.queryByText(/new and finished tasks show up here/i)).toBeNull();
    expect(chart.getByText("Created")).toBeTruthy();
    expect(chart.getByText("Completed")).toBeTruthy();
  });
});

describe("Dashboard width", () => {
  it("uses the width the sidebar freed up, up to a readable maximum", async () => {
    const { container } = await renderDashboard();
    expect(container.firstElementChild!.className).toContain("max-w-7xl");
  });

  it("lays the six panels out three across on a wide screen", async () => {
    await renderDashboard();
    const card = screen.getByRole("heading", { name: "Velocity (tasks done/week)" }).closest("div")!;
    expect(card.parentElement!.className).toContain("xl:grid-cols-3");
  });
});
