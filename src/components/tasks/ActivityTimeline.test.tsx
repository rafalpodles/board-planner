// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { ActivityTimeline } from "./ActivityTimeline";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));

const log = {
  _id: "l1",
  action: "created",
  field: "",
  oldValue: "",
  newValue: "",
  user: { _id: "u1", username: "rpo", fullName: "Rafal Podles" },
  createdAt: "2026-08-01T00:00:00Z",
};

beforeEach(() => {
  api.get.mockReset();
});

afterEach(cleanup);

describe("ActivityTimeline", () => {
  it("names the user who acted", async () => {
    api.get.mockResolvedValue([log]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText(/Rafal Podles created this task/)).toBeTruthy());
  });

  // typeof null === "object", so a deleted user used to take the populated branch and throw
  it("falls back to Unknown when the user was deleted", async () => {
    api.get.mockResolvedValue([{ ...log, user: null }]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText(/Unknown created this task/)).toBeTruthy());
  });
});
