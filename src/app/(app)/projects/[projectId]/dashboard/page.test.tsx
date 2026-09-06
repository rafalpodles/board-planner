// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import DashboardPage from "./page";
import { TASK_STATUSES } from "@/types";

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
  assigneeBreakdown: { owner: 4 },
  difficultyBreakdown: { M: 4 },
  velocity: weeks.map((week) => ({ week, count: 0 })),
  createdOverTime: weeks.map((week) => ({ week, created: 0, completed: 0 })),
};

// What /api/projects/[projectId]/stats really answers for a project with no tasks:
// the status keys are seeded to zero, the other breakdowns come back absent
const noTasksStats: Partial<Stats> = {
  total: 0,
  statusBreakdown: Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])),
  categoryBreakdown: {},
  assigneeBreakdown: {},
  difficultyBreakdown: {},
};

async function renderDashboard(stats: Partial<Stats> = {}) {
  api.get.mockImplementation((url: string) =>
    url.endsWith("/stats")
      ? Promise.resolve({ ...emptyStats, ...stats })
      : Promise.resolve({ name: "Board Planner" })
  );
  const view = render(<DashboardPage />);
  await screen.findByRole("heading", { name: /Dashboard/ });
  return view;
}

function panel(title: string) {
  return within(screen.getByRole("heading", { name: title }).closest("div")!);
}

function barStylesOf(chartTitle: string): string[] {
  const card = screen.getByRole("heading", { name: chartTitle }).closest("div")!;
  return [...card.querySelectorAll<HTMLElement>("[style*='height']")].map((bar) => bar.style.height);
}

function barHeightsOf(chartTitle: string): number[] {
  return barStylesOf(chartTitle).map((height) => parseFloat(height) || 0);
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

  it("explains every breakdown on a board that has no tasks at all", async () => {
    await renderDashboard(noTasksStats);
    expect(screen.getByText(/every task counts towards its column here/i)).toBeTruthy();
    expect(screen.getByText(/categories appear as soon as the board has tasks/i)).toBeTruthy();
    expect(screen.getByText(/assign a task to see the split per person/i)).toBeTruthy();
    expect(screen.getByText(/the S\/M\/L\/XL split shows up once tasks exist/i)).toBeTruthy();
    expect(screen.getByText(/each week a task reaches Done adds a bar/i)).toBeTruthy();
    expect(screen.getByText(/new and finished tasks show up here/i)).toBeTruthy();
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

  // A percentage height is what made every bar collapse to its minimum: the column
  // sizes to its content, so there is nothing for the percentage to resolve against
  it("sizes the velocity bars in px, never as a percentage of an auto-height column", async () => {
    await renderDashboard({
      velocity: weeks.map((week, i) => ({ week, count: i })),
    });

    for (const height of barStylesOf("Velocity (tasks done/week)")) {
      expect(height).toMatch(/px$/);
    }
  });

  it("scales the velocity bars to the data instead of drawing them all flat", async () => {
    await renderDashboard({
      velocity: weeks.map((week, i) => ({ week, count: [0, 1, 2, 4, 0, 8, 3, 0][i] })),
    });
    const heights = barHeightsOf("Velocity (tasks done/week)");

    expect(heights).toHaveLength(8);
    expect(heights[5]).toBeGreaterThan(heights[3]);
    expect(heights[3]).toBeGreaterThan(heights[1]);
    expect(heights.filter((h) => h === 0)).toHaveLength(3);
    expect(new Set(heights.filter((h) => h > 0)).size).toBe(5);
  });

  it("keeps a week with a single completion visible rather than invisible", async () => {
    await renderDashboard({
      velocity: weeks.map((week, i) => ({ week, count: i === 0 ? 1 : i === 7 ? 200 : 0 })),
    });
    const heights = barHeightsOf("Velocity (tasks done/week)");

    expect(heights[0]).toBeGreaterThan(0);
    expect(heights[7]).toBeGreaterThan(heights[0]);
  });

  it("gives the only bar of a single-bucket chart the full track", async () => {
    await renderDashboard({ velocity: [{ week: "Jul 20", count: 3 }] });
    const [only] = barHeightsOf("Velocity (tasks done/week)");

    expect(only).toBeGreaterThan(0);
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

  it("still draws the breakdowns once a single task exists", async () => {
    await renderDashboard();
    expect(screen.queryByText(/every task counts towards its column here/i)).toBeNull();
    expect(screen.queryByText(/categories appear as soon as the board has tasks/i)).toBeNull();
    expect(screen.queryByText(/assign a task to see the split per person/i)).toBeNull();
    expect(screen.queryByText(/the S\/M\/L\/XL split shows up once tasks exist/i)).toBeNull();
  });
});
