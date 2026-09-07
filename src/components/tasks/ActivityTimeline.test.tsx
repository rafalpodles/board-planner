// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
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
  user: { _id: "u1", username: "owner", fullName: "Owner Name" },
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
    await waitFor(() => expect(screen.getByText(/Owner Name created this task/)).toBeTruthy());
  });

  // typeof null === "object", so a deleted user used to take the populated branch and throw
  it("falls back to Unknown when the user was deleted", async () => {
    api.get.mockResolvedValue([{ ...log, user: null }]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText(/Unknown created this task/)).toBeTruthy());
  });

  // "updated Difficulty" is not history — a reader wants to know what it became
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

  // createNextRecurrence stores a sentence in newValue, not a value the field was set to
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

  // This branch newly routes free text through formatValue: on main only status values, which are
  // short, ever reached it. A title has no length limit.
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

  // Entries written before CP-250 carry no values at all
  it("keeps the plain wording for an entry that recorded no values", async () => {
    api.get.mockResolvedValue([{ ...log, action: "updated", field: "checklist" }]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText(/updated checklist/)).toBeTruthy());
  });
});

/**
 * BP-586. `TaskActivityPanel` reconciles this panel in place on a task switch, so without a reset
 * and a sequence guard the task just left keeps its rows, its count and — if the new read fails —
 * a failure line over another task's history. The shape is the one BP-577 gave `Comments`.
 */
describe("ActivityTimeline across a task switch", () => {
  it("does not present the previous task's rows as this task's", async () => {
    api.get.mockResolvedValue([log]);
    const view = render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText(/Owner Name/)).toBeTruthy());

    const pending: ((rows: unknown[]) => void)[] = [];
    api.get.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    view.rerender(<ActivityTimeline projectId="TP" taskId="t2" />);

    expect(screen.queryByText(/Owner Name/)).toBeNull();

    await act(async () => pending.forEach((resolve) => resolve([])));
    await waitFor(() => expect(screen.getByText(/No history yet/)).toBeTruthy());
  });

  it("ignores the previous task's read when it lands late", async () => {
    const pending: ((rows: unknown[]) => void)[] = [];
    api.get.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const view = render(<ActivityTimeline projectId="TP" taskId="t1" />);

    view.rerender(<ActivityTimeline projectId="TP" taskId="t2" />);
    await act(async () => pending[pending.length - 1]([]));
    await waitFor(() => expect(screen.getByText(/No history yet/)).toBeTruthy());

    await act(async () => pending[0]([log]));

    expect(screen.queryByText(/Owner Name/)).toBeNull();
  });

  it("does not let the previous task's failure claim this task's history", async () => {
    const pending: { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }[] = [];
    api.get.mockImplementation(
      () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
    );
    const onCountChange = vi.fn();
    const view = render(
      <ActivityTimeline projectId="TP" taskId="t1" onCountChange={onCountChange} />
    );

    view.rerender(<ActivityTimeline projectId="TP" taskId="t2" onCountChange={onCountChange} />);
    await act(async () => pending[pending.length - 1].resolve([log]));
    await waitFor(() => expect(screen.getByText(/Owner Name/)).toBeTruthy());

    await act(async () => pending[0].reject(new Error("network")));

    expect(screen.queryByText(/Could not load/)).toBeNull();
    expect(screen.getByText(/Owner Name/)).toBeTruthy();
    // And the tab keeps the number the read that answered earned
    expect(onCountChange).toHaveBeenLastCalledWith(1);
  });

  it("withdraws the count it reported when the task changes", async () => {
    const onCountChange = vi.fn();
    api.get.mockResolvedValue([log]);
    const view = render(
      <ActivityTimeline projectId="TP" taskId="t1" onCountChange={onCountChange} />
    );
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1));

    api.get.mockImplementation(() => new Promise(() => {}));
    view.rerender(<ActivityTimeline projectId="TP" taskId="t2" onCountChange={onCountChange} />);

    expect(onCountChange).toHaveBeenLastCalledWith(null);
  });

  // The other half of that guard: mounting must not fire the read twice
  it("reads once on mount, not once per effect", async () => {
    api.get.mockResolvedValue([log]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);

    await waitFor(() => expect(screen.getByText(/Owner Name/)).toBeTruthy());
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  // The one reachable line the rest of these miss: a refresh that succeeds has to take the
  // failure sentence down with it, or it sits above rows that did load
  it("clears a failure when a refresh of the same task answers", async () => {
    api.get.mockRejectedValueOnce(new Error("network"));
    const view = render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText(/Could not load/)).toBeTruthy());

    api.get.mockResolvedValue([log]);
    view.rerender(<ActivityTimeline projectId="TP" taskId="t1" refreshKey={1} />);

    await waitFor(() => expect(screen.getByText(/Owner Name/)).toBeTruthy());
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  // A refresh of the same task is not a switch: what is on screen belongs to it either way
  it("keeps the rows on screen while a refresh of the same task runs", async () => {
    api.get.mockResolvedValue([log]);
    const view = render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText(/Owner Name/)).toBeTruthy());

    api.get.mockImplementation(() => new Promise(() => {}));
    view.rerender(<ActivityTimeline projectId="TP" taskId="t1" refreshKey={1} />);

    expect(screen.getByText(/Owner Name/)).toBeTruthy();
  });

  // BP-582, the same shape as Comments next door: the tab draws this number, and a read that
  // failed is no evidence for the one before it
  it("withdraws the count when a later read fails", async () => {
    const onCountChange = vi.fn();
    api.get.mockResolvedValue([log]);
    const view = render(
      <ActivityTimeline projectId="TP" taskId="t1" refreshKey={0} onCountChange={onCountChange} />
    );
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1));

    api.get.mockRejectedValue(new Error("the read that never answered"));
    view.rerender(
      <ActivityTimeline projectId="TP" taskId="t1" refreshKey={1} onCountChange={onCountChange} />
    );

    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(null));
  });

  /**
   * BP-582 review. Comments trades its withdrawn number for a Retry; History traded it for nothing,
   * so the only ways back were changing task or posting a comment. And with no reading state, an
   * in-flight read claimed "No history yet" — the very defect BP-577 fixed next door.
   */
  it("offers the read again rather than a sentence and nothing", async () => {
    api.get.mockRejectedValueOnce(new Error("network"));
    render(<ActivityTimeline projectId="TP" taskId="t1" />);

    await waitFor(() => expect(screen.getByTestId("history-error")).toBeTruthy());
    expect(screen.queryByText(/No history yet/)).toBeNull();

    api.get.mockResolvedValue([log]);
    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
    });

    await waitFor(() => expect(screen.getByText(/Owner Name/)).toBeTruthy());
    expect(screen.queryByTestId("history-error")).toBeNull();
  });

  it("claims nothing about the history while it is still being read", async () => {
    api.get.mockImplementation(() => new Promise(() => {}));
    render(<ActivityTimeline projectId="TP" taskId="t1" />);

    expect(screen.queryByText(/No history yet/)).toBeNull();
  });

  // The control: a task nothing has happened to still says so
  it("still says there is none when the read answers with none", async () => {
    api.get.mockResolvedValue([]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);

    await waitFor(() => expect(screen.getByText(/No history yet/)).toBeTruthy());
  });
});
