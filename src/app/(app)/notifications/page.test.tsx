// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import NotificationsPage from "./page";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));

const notification = {
  _id: "n1",
  type: "task_assigned",
  read: false,
  actor: { _id: "u2", username: "kasia", fullName: "Kasia Nowak" },
  project: { _id: "p1", key: "TP" },
  task: { _id: "t1", taskNumber: 4 },
  message: "assigned you a task",
  createdAt: "2026-08-01T00:00:00Z",
};

beforeEach(() => {
  api.get.mockReset();
});

afterEach(cleanup);

describe("NotificationsPage", () => {
  it("names the actor", async () => {
    api.get.mockResolvedValue([notification]);
    render(<NotificationsPage />);
    await waitFor(() => expect(screen.getByText(/Kasia Nowak/)).toBeTruthy());
  });

  it("renders a notification whose actor was deleted", async () => {
    api.get.mockResolvedValue([{ ...notification, actor: null }]);
    render(<NotificationsPage />);
    await waitFor(() => expect(screen.getByText(/Assigned/)).toBeTruthy());
  });

  it("renders a notification whose project was deleted", async () => {
    api.get.mockResolvedValue([{ ...notification, project: null }]);
    render(<NotificationsPage />);
    await waitFor(() => expect(screen.getByText(/Assigned/)).toBeTruthy());
  });
});
