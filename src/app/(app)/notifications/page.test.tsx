// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), patch: vi.fn() } }));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/notifications",
}));

const { default: NotificationsPage } = await import("./page");

const base = {
  recipient: "u1",
  actor: { _id: "a1", username: "olga", fullName: "Olga" },
  project: { _id: "p1", key: "ORB", name: "Orbit" },
  body: "",
  read: false,
  createdAt: new Date().toISOString(),
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("where a row leads", () => {
  it("takes a board_access row to the board", async () => {
    api.get.mockResolvedValue([
      { ...base, _id: "n1", type: "board_access", task: null, title: "Olga added you to Orbit" },
    ]);
    render(<NotificationsPage />);

    const link = await screen.findByRole("link", { name: /Olga added you to Orbit/ });
    expect(link.getAttribute("href")).toBe("/projects/ORB");
    expect(link.textContent).toContain("Board access");
  });

  // A task that has since been deleted populates as null; that row is about the task, not the board
  it("does not send a task row whose task is gone to the board", async () => {
    api.get.mockResolvedValue([
      { ...base, _id: "n2", type: "comment_added", task: null, title: "New comment on ORB-4" },
    ]);
    render(<NotificationsPage />);

    const link = await screen.findByRole("link", { name: /New comment on ORB-4/ });
    expect(link.getAttribute("href")).toBe("/notifications");
  });
});
