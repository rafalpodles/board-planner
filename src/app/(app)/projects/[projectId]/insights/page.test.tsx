// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import InsightsPage from "./page";
import { sampleInsights } from "@/components/insights/sample";

const { api } = vi.hoisted(() => ({ api: { get: vi.fn() } }));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: vi.fn() }),
}));

const PROJECT = {
  _id: "p1",
  key: "INS",
  name: "Insights board",
  categories: [{ name: "bug", color: "#f00" }],
  columns: [
    { id: "todo", label: "To Do", color: "#000", role: "approved", order: 0 },
    { id: "doing", label: "Doing", color: "#000", role: "active", order: 1 },
    { id: "done", label: "Done", color: "#000", role: "done", order: 2 },
  ],
};

function answer({
  plan = "pro",
  project = PROJECT,
  entitlementFails = false,
  insightsFails = null as null | { status: number; message: string },
} = {}) {
  api.get.mockImplementation((url: string) => {
    if (url === "/api/entitlements") {
      return entitlementFails ? Promise.reject(new Error("down")) : Promise.resolve({ plan, features: [], expiresAt: null });
    }
    if (url === "/api/projects/p1") return Promise.resolve(project);
    if (url === "/api/projects/p1/sprints") return Promise.resolve([{ _id: "s1", name: "Sprint 1" }]);
    if (url.startsWith("/api/projects/p1/insights")) {
      if (insightsFails) return Promise.reject(Object.assign(new Error(insightsFails.message), { status: insightsFails.status }));
      return Promise.resolve({ ...sampleInsights(Date.now()), sprint: null, category: null });
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

const insightsCalls = () => api.get.mock.calls.map(([url]) => url as string).filter((url) => url.includes("/insights"));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("InsightsPage", () => {
  it("on Pro asks for the last 12 weeks and draws the board's figures, with no upsell", async () => {
    answer();
    render(<InsightsPage />);

    await screen.findByTestId("insights-live");
    expect(insightsCalls()).toEqual(["/api/projects/p1/insights?weeks=12"]);
    expect(screen.queryByText("Sample data")).toBeNull();
    expect(screen.queryByTestId("insights-upsell")).toBeNull();
    expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
  });

  it("asks again for a category and for a sprint", async () => {
    answer();
    render(<InsightsPage />);
    await screen.findByTestId("insights-live");

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "bug" } });
    await waitFor(() => expect(insightsCalls()).toContain("/api/projects/p1/insights?weeks=12&category=bug"));
    await screen.findByRole("option", { name: "Sprint: Sprint 1" });
    fireEvent.change(screen.getByLabelText("Window"), { target: { value: "s1" } });
    await waitFor(() => expect(insightsCalls()).toContain("/api/projects/p1/insights?sprint=s1&category=bug"));
  });

  it("on Free shows the sample and the upsell and never asks for insights", async () => {
    answer({ plan: "free" });
    render(<InsightsPage />);

    await screen.findByTestId("insights-sample");
    expect(screen.getByTestId("insights-upsell").textContent).toContain("sample data");
    expect(screen.queryByTestId("insights-filters")).toBeNull();
    expect(screen.getAllByText("Sample data")).toHaveLength(4);
    expect(screen.getByTestId("insights-aging").textContent).toContain("DEMO-151");
    expect(screen.getByTestId("insights-aging").textContent).not.toContain("INS-");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(insightsCalls()).toEqual([]);
  });

  it("says the plan could not be read rather than showing Free's sample", async () => {
    answer({ entitlementFails: true });
    render(<InsightsPage />);

    expect((await screen.findByTestId("insights-error")).textContent).toContain("plan could not be read");
    expect(screen.queryByTestId("insights-sample")).toBeNull();
    expect(insightsCalls()).toEqual([]);
  });

  it("a 402 the plan read did not foresee, such as an expired trial, shows the sample and asks once", async () => {
    answer({ insightsFails: { status: 402, message: "This feature requires a plan upgrade" } });
    render(<InsightsPage />);

    await screen.findByTestId("insights-sample");
    expect(screen.getByTestId("insights-upsell")).toBeTruthy();
    expect(screen.queryByTestId("insights-error")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(insightsCalls()).toHaveLength(1);
  });

  it("a sprint that is gone answers an error on the page, not a page that does not exist", async () => {
    answer({ insightsFails: { status: 404, message: "Sprint not found" } });
    render(<InsightsPage />);

    expect((await screen.findByTestId("insights-error")).textContent).toContain("Sprint not found");
    expect(screen.queryByTestId("insights-not-found")).toBeNull();
  });

  it("a board with no Done column says so and shows a dash for throughput, not 0", async () => {
    answer({ project: { ...PROJECT, columns: PROJECT.columns.filter((c) => c.role !== "done") } });
    render(<InsightsPage />);

    await screen.findByTestId("insights-no-done-column");
    expect((await screen.findByTestId("insights-tiles")).textContent).toContain("Throughput—No Done column");
  });
});
