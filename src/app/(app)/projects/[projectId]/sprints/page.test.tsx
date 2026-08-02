// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import SprintsPage from "./page";
import { ApiSprint } from "@/types";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const sprints = [
  {
    _id: "s1",
    name: "Sprint 12",
    startDate: "2026-07-20T00:00:00Z",
    endDate: "2026-08-03T00:00:00Z",
    goal: "Ship the layout pass",
    status: "active",
    taskCount: 8,
    doneCount: 4,
  },
  {
    _id: "s2",
    name: "Sprint 13",
    startDate: "2026-08-03T00:00:00Z",
    endDate: "2026-08-17T00:00:00Z",
    goal: "",
    status: "planned",
    taskCount: 0,
    doneCount: 0,
  },
] as ApiSprint[];

async function renderSprints(data: ApiSprint[] = sprints) {
  api.get.mockResolvedValue(data);
  const view = render(<SprintsPage />);
  await screen.findByRole("heading", { name: "Sprints" });
  return view;
}

beforeEach(() => {
  api.get.mockReset();
});
afterEach(cleanup);

describe("Sprints page", () => {
  it("still lists every sprint", async () => {
    await renderSprints();
    expect(screen.getByRole("heading", { name: "Sprint 12" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sprint 13" })).toBeTruthy();
    expect(screen.getByText("4/8 tasks done")).toBeTruthy();
  });

  it("keeps the empty state when a project has no sprints", async () => {
    await renderSprints([]);
    expect(screen.getByText("No sprints yet")).toBeTruthy();
    expect(screen.getByText("Create your first sprint")).toBeTruthy();
  });
});
