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

/**
 * BP-628. A sync giving a task a pull request, or taking one away, used to leave no trace on the
 * task at all — so "there was a pull request here last week" had nowhere to look.
 */
describe("ActivityTimeline — what a sync did to the links", () => {
  const PR = "https://github.com/example/board/pull/412";

  it("names what was linked, by address", async () => {
    api.get.mockResolvedValue([
      { ...log, action: "pr_linked", field: "linkedPRs", oldValue: "", newValue: PR },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(
        screen.getByText("Owner Name linked github.com/example/board/pull/412")
      ).toBeTruthy()
    );
  });

  it("names what was taken away", async () => {
    api.get.mockResolvedValue([
      { ...log, action: "pr_unlinked", field: "linkedPRs", oldValue: PR, newValue: "" },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(
        screen.getByText("Owner Name unlinked github.com/example/board/pull/412")
      ).toBeTruthy()
    );
  });

  // A scheduled round has nobody to name, and the row is written anyway — so the absence has to
  // read as the sync rather than as the deleted account it looks identical to
  it("reads a link row with no user as the sync", async () => {
    api.get.mockResolvedValue([
      { ...log, user: null, action: "pr_unlinked", field: "linkedPRs", oldValue: PR, newValue: "" },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(screen.getByText(/^The repository sync unlinked /)).toBeTruthy()
    );
  });

  // The control for the line above: the same absence on any other action is still a lost author
  it("still calls a missing author Unknown everywhere else", async () => {
    api.get.mockResolvedValue([{ ...log, user: null, action: "comment_added" }]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText("Unknown added a comment")).toBeTruthy());
  });

  // `formatValue` cuts the tail, which on a pull request url is the repository and the number
  it("shortens a long address from the front, keeping the number", async () => {
    const long = `https://github.example.com/a-rather-long-organisation-name/and-its-longer-repository/pull/12345`;
    api.get.mockResolvedValue([
      { ...log, action: "pr_linked", field: "linkedPRs", oldValue: "", newValue: long },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText(/….*\/pull\/12345$/)).toBeTruthy());
  });
});

/**
 * BP-658. One link writes a row at both ends, and `field` carries the relation as THIS task
 * experiences it — so the parent's row and the child's row are the same write read from opposite
 * sides, and neither may render as the other.
 */
describe("ActivityTimeline — what a link did to this task", () => {
  it("reads a gained child from the parent's side", async () => {
    api.get.mockResolvedValue([
      { ...log, action: "link_added", field: "parent_of", oldValue: "", newValue: "BP-11" },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(screen.getByText("Owner Name made this task the parent of BP-11")).toBeTruthy()
    );
  });

  it("reads the same write from the child's side as a gained parent", async () => {
    api.get.mockResolvedValue([
      { ...log, action: "link_added", field: "child_of", oldValue: "", newValue: "BP-10" },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(screen.getByText("Owner Name made BP-10 the parent of this task")).toBeTruthy()
    );
  });

  // The epic nobody named in the call: this row is the only place it is written down
  it("names the child an epic lost", async () => {
    api.get.mockResolvedValue([
      { ...log, action: "link_removed", field: "parent_of", oldValue: "BP-11", newValue: "" },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(screen.getByText("Owner Name removed BP-11 from this task's children")).toBeTruthy()
    );
  });

  it("distinguishes a blocker from the task it blocks", async () => {
    api.get.mockResolvedValue([
      { ...log, _id: "l1", action: "link_added", field: "blocked_by", oldValue: "", newValue: "BP-2" },
      { ...log, _id: "l2", action: "link_added", field: "blocks", oldValue: "", newValue: "BP-3" },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(screen.getByText("Owner Name marked this task as blocked by BP-2")).toBeTruthy()
    );
    expect(screen.getByText("Owner Name marked BP-3 as blocked by this task")).toBeTruthy();
  });

  it("reads a duplicate from both sides", async () => {
    api.get.mockResolvedValue([
      { ...log, _id: "l1", action: "link_added", field: "duplicates", oldValue: "", newValue: "BP-2" },
      {
        ...log,
        _id: "l2",
        action: "link_removed",
        field: "duplicated_by",
        oldValue: "BP-3",
        newValue: "",
      },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(screen.getByText("Owner Name marked this task as a duplicate of BP-2")).toBeTruthy()
    );
    expect(screen.getByText("Owner Name removed BP-3 as a duplicate of this task")).toBeTruthy();
  });

  // The control: an unknown action still falls through to the generic line rather than
  // rendering as a link with an empty other end
  it("does not read an unrelated action as a link", async () => {
    api.get.mockResolvedValue([{ ...log, action: "something_else" }]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(screen.getByText("Owner Name performed an action")).toBeTruthy()
    );
  });

  /**
   * The other half of that control, and the one the first draft missed: a KNOWN action whose
   * `field` is not a direction this app writes. `field` carries no enum in the schema and the
   * component casts it, so an old or hand-written row reaches the phrasing — and before the
   * default branch it rendered an icon, a timestamp and no sentence at all.
   */
  it("still says something when the direction is one it does not know", async () => {
    api.get.mockResolvedValue([
      { ...log, action: "link_added", field: "", oldValue: "", newValue: "BP-2" },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);
    await waitFor(() =>
      expect(screen.getByText("Owner Name linked this task to BP-2")).toBeTruthy()
    );
  });

  // `⚯` was legible in a browser and two loose rings at 12px. This pins the glyph to the set the
  // rest of the table already renders, and the removal to the one every other removal uses.
  it("draws a link with a glyph this table already proves, and a removal with the removal mark", async () => {
    api.get.mockResolvedValue([
      { ...log, _id: "l1", action: "link_added", field: "relates", newValue: "BP-2" },
      { ...log, _id: "l2", action: "link_removed", field: "relates", oldValue: "BP-3" },
    ]);
    render(<ActivityTimeline projectId="TP" taskId="t1" />);

    await waitFor(() => expect(screen.getByText("↗")).toBeTruthy());
    expect(screen.getByText("×")).toBeTruthy();
    // Decoration: the sentence beside it already says what happened
    expect(screen.getByText("↗").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("×").className).toContain("text-danger");
  });
});
