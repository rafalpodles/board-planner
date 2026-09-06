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

  it("falls back to Unknown when the user was deleted", async () => {
    api.get.mockResolvedValue([{ ...log, user: null }]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText(/Unknown created this task/)).toBeTruthy());
  });

  it("says what a field changed from and to", async () => {
    api.get.mockResolvedValue([
      { ...log, action: "updated", field: "Difficulty", oldValue: "M", newValue: "L" },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(screen.getByText(/changed Difficulty from M to L/)).toBeTruthy()
    );
  });

  it("marks a cleared value as empty rather than trailing off", async () => {
    api.get.mockResolvedValue([
      { ...log, action: "updated", field: "Difficulty", oldValue: "M", newValue: "" },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(screen.getByText(/changed Difficulty from M to \(empty\)/)).toBeTruthy()
    );
  });

  it("renders the recurrence note as a note, not as a value the field changed to", async () => {
    api.get.mockResolvedValue([
      {
        ...log,
        action: "updated",
        field: "recurrence",
        oldValue: "",
        newValue: "Next occurrence created: CP-251",
      },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(screen.getByText(/Next occurrence created: CP-251/)).toBeTruthy()
    );
    expect(screen.queryByText(/changed recurrence from/)).toBeNull();
  });

  it("truncates a value too long to sit in a timeline row", async () => {
    const long = "x".repeat(200);
    api.get.mockResolvedValue([
      { ...log, action: "updated", field: "title", oldValue: "short", newValue: long },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText(/changed title from short to/)).toBeTruthy());
    expect(screen.queryByText(new RegExp(long))).toBeNull();
    expect(screen.getByText(/x{60}…/)).toBeTruthy();
  });

  it("keeps the plain wording for an entry that recorded no values", async () => {
    api.get.mockResolvedValue([{ ...log, action: "updated", field: "checklist" }]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText(/updated checklist/)).toBeTruthy());
  });
});
