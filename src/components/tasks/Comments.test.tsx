// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import { Comments } from "./Comments";

const { api, auth } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  auth: { user: { _id: "u1", username: "owner", fullName: "Owner Name" } },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const author = { _id: "u2", username: "kasia", fullName: "Kasia Nowak" };

const comment = {
  _id: "c1",
  body: "A remark",
  author,
  reactions: [],
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

function serve(comments: unknown[]) {
  api.get.mockImplementation((url: string) =>
    url.includes("/comments") ? Promise.resolve(comments) : Promise.resolve([])
  );
}

beforeEach(() => {
  api.get.mockReset();
});

afterEach(cleanup);

describe("Comments", () => {
  it("names the comment author", async () => {
    serve([comment]);
    render(<Comments projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText("Kasia Nowak")).toBeTruthy());
  });

  // typeof null === "object", so a deleted author used to take the populated branch and throw
  it("renders a comment whose author was deleted", async () => {
    serve([{ ...comment, author: null }]);
    render(<Comments projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText("Unknown")).toBeTruthy());
    expect(screen.getByText("A remark")).toBeTruthy();
  });

  it("renders a reaction whose author was deleted", async () => {
    serve([{ ...comment, reactions: [{ emoji: "👍", user: null }] }]);
    render(<Comments projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText("A remark")).toBeTruthy());
    // The pill carries the reactor's name in its title; a deleted user reads as Unknown
    expect(screen.getByTitle(/Unknown/)).toBeTruthy();
  });
});

// BP-254. Written before the autocomplete was pulled out of this component and given a second
// trigger for task keys — so the refactor has something to break. Every assertion here describes
// behaviour that already shipped, not behaviour being added.
describe("mentioning a person", () => {
  const people = [
    { _id: "u2", username: "kasia", fullName: "Kasia Nowak" },
    { _id: "u3", username: "karol", fullName: "Karol Wisniewski" },
    { _id: "u4", username: "tomek", fullName: "Tomek Zielinski" },
  ];

  function serveAll(comments: unknown[] = []) {
    api.get.mockImplementation((url: string) =>
      url.includes("/comments")
        ? Promise.resolve(comments)
        : url.includes("/assignable-users")
          ? Promise.resolve(people)
          : Promise.resolve([])
    );
  }

  async function composer() {
    serveAll();
    render(<Comments projectId="TP" taskId="t1" />);
    const box = await screen.findByPlaceholderText(/@mention someone/i);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/projects/TP/assignable-users"));
    return box as HTMLTextAreaElement;
  }

  it("offers people once an @ is typed", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "thanks @ka" } });

    await waitFor(() => expect(screen.getByText("Kasia Nowak")).toBeTruthy());
    expect(screen.getByText("Karol Wisniewski")).toBeTruthy();
    // Filtered, not merely listed
    expect(screen.queryByText("Tomek Zielinski")).toBeNull();
  });

  it("matches the full name as well as the username", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "@nowak" } });

    await waitFor(() => expect(screen.getByText("Kasia Nowak")).toBeTruthy());
  });

  it("offers nobody until an @ is typed", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "kasia" } });

    await waitFor(() => expect(screen.queryByText("Kasia Nowak")).toBeNull());
  });

  it("puts the chosen name into the text, with a space after it", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "thanks @ka" } });
    await waitFor(() => expect(screen.getByText("Kasia Nowak")).toBeTruthy());
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(box.value).toBe("thanks @kasia "));
  });

  it("moves through the list with the arrow keys", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "@ka" } });
    await waitFor(() => expect(screen.getByText("Kasia Nowak")).toBeTruthy());
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(box.value).toBe("@karol "));
  });

  it("dismisses the list on Escape without changing the text", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "@ka" } });
    await waitFor(() => expect(screen.getByText("Kasia Nowak")).toBeTruthy());
    fireEvent.keyDown(box, { key: "Escape" });

    await waitFor(() => expect(screen.queryByText("Kasia Nowak")).toBeNull());
    expect(box.value).toBe("@ka");
  });

  // Enter is how a comment gets sent in some editors, so the list must own the key only while open
  it("leaves Enter alone once the list is closed", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "@ka" } });
    await waitFor(() => expect(screen.getByText("Kasia Nowak")).toBeTruthy());
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(box.value).toBe("@ka");
  });
});

describe("referring to another task", () => {
  const people = [{ _id: "u2", username: "kasia", fullName: "Kasia Nowak" }];
  const suggestions = [
    { _id: "t10", taskNumber: 1, title: "Board renders" },
    { _id: "t11", taskNumber: 12, title: "Auth token expiry" },
  ];

  function serveAll() {
    api.get.mockImplementation((url: string) =>
      url.includes("/tasks/suggest")
        ? Promise.resolve(suggestions)
        : url.includes("/assignable-users")
          ? Promise.resolve(people)
          : Promise.resolve([])
    );
  }

  async function composer() {
    serveAll();
    render(<Comments projectId="TP" taskId="t1" scope={{ key: "TP", formerKeys: ["CP"] }} />);
    const box = await screen.findByPlaceholderText(/@mention someone/i);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/projects/TP/assignable-users"));
    return box as HTMLTextAreaElement;
  }

  it("offers tasks once the board's own key is typed", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "blocked by TP-" } });

    await waitFor(() => expect(screen.getByText("TP-1")).toBeTruthy());
    expect(screen.getByText("Auth token expiry")).toBeTruthy();
  });

  it("asks the server for what was typed after the key", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "see TP-auth" } });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/api/projects/TP/tasks/suggest?q=auth")
    );
  });

  // The key is stored as plain text; the link is made when it is rendered, so a project renamed
  // later keeps working without migrating every description
  it("inserts the key itself, not a markdown link", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "blocked by TP-" } });
    await waitFor(() => expect(screen.getByText("TP-1")).toBeTruthy());
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(box.value).toBe("blocked by TP-1 "));
  });

  // The guard before the key has to be zero-width: consuming it would take the space with it
  it("keeps the character before the key", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "x TP-" } });
    await waitFor(() => expect(screen.getByText("TP-1")).toBeTruthy());
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(box.value).toBe("x TP-1 "));
  });

  it("offers nothing for a key that is not this board's", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "blocked by ACME-" } });

    await waitFor(() => expect(screen.queryByText("TP-1")).toBeNull());
  });
});

/**
 * BP-577. A failed read left the list at [] and the panel said "No comments yet" — a claim about
 * the discussion on this task. The toast clears after three seconds; the sentence did not.
 */
describe("Comments when the read fails", () => {
  it("says the read failed instead of claiming there are none", async () => {
    api.get.mockImplementation(() => Promise.reject(new Error("network")));
    render(<Comments projectId="TP" taskId="t1" />);

    await waitFor(() => expect(screen.getByTestId("comments-error")).toBeTruthy());
    expect(screen.queryByText("No comments yet")).toBeNull();
  });

  it("reads again on Retry", async () => {
    api.get
      .mockImplementationOnce(() => Promise.reject(new Error("network")))
      .mockImplementation(() => Promise.resolve([comment]));
    render(<Comments projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByTestId("comments-error")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByText("Kasia Nowak")).toBeTruthy());
    expect(screen.queryByTestId("comments-error")).toBeNull();
  });

  // The same class of claim, one state earlier: a read still running is not an empty discussion
  it("shows a spinner rather than the claim while the first read is in flight", async () => {
    // The panel reads more than the comments, so every pending read has to be released
    const pending: ((rows: unknown[]) => void)[] = [];
    api.get.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    render(<Comments projectId="TP" taskId="t1" />);

    expect(screen.getByText("Loading the comments")).toBeTruthy();
    expect(screen.queryByText("No comments yet")).toBeNull();

    await act(async () => pending.forEach((resolve) => resolve([])));
    await waitFor(() => expect(screen.getByText("No comments yet")).toBeTruthy());
  });

  // A task switch reconciles the panel in place, so the previous discussion must not stand in
  it("does not show the previous task's comments while the next task is being read", async () => {
    serve([comment]);
    const view = render(<Comments projectId="TP" taskId="t1" />);
    await waitFor(() => expect(screen.getByText("Kasia Nowak")).toBeTruthy());

    const pending: ((rows: unknown[]) => void)[] = [];
    api.get.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    view.rerender(<Comments projectId="TP" taskId="t2" />);

    expect(screen.queryByText("Kasia Nowak")).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();

    await act(async () => pending.forEach((resolve) => resolve([])));
    await waitFor(() => expect(screen.getByText("No comments yet")).toBeTruthy());
  });

  // The out-of-order half: the previous task's read is still in flight when the new one answers
  it("ignores the previous task's read when it lands late", async () => {
    const pending: ((rows: unknown[]) => void)[] = [];
    api.get.mockImplementation((url: string) =>
      url.includes("/comments")
        ? new Promise((resolve) => pending.push(resolve))
        : Promise.resolve([])
    );
    const view = render(<Comments projectId="TP" taskId="t1" />);

    view.rerender(<Comments projectId="TP" taskId="t2" />);
    await act(async () => pending[pending.length - 1]([]));
    await waitFor(() => expect(screen.getByText("No comments yet")).toBeTruthy());

    // t1 answers at last, with a comment that belongs to a task nobody is looking at
    await act(async () => pending[0]([comment]));

    expect(screen.queryByText("Kasia Nowak")).toBeNull();
    expect(screen.getByText("No comments yet")).toBeTruthy();
  });

  it("does not let the previous task's failure claim the new task's discussion", async () => {
    const pending: { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }[] = [];
    api.get.mockImplementation((url: string) =>
      url.includes("/comments")
        ? new Promise((resolve, reject) => pending.push({ resolve, reject }))
        : Promise.resolve([])
    );
    const view = render(<Comments projectId="TP" taskId="t1" />);

    view.rerender(<Comments projectId="TP" taskId="t2" />);
    await act(async () => pending[pending.length - 1].resolve([comment]));
    await waitFor(() => expect(screen.getByText("Kasia Nowak")).toBeTruthy());

    await act(async () => pending[0].reject(new Error("network")));

    expect(screen.queryByTestId("comments-error")).toBeNull();
    expect(screen.getByText("Kasia Nowak")).toBeTruthy();
  });

  // The third exit: a superseded read must not tear the spinner down and let "No comments yet"
  // stand as a claim about a task whose own read is still running
  it("keeps the spinner when the previous task's read answers first", async () => {
    const pending: ((rows: unknown[]) => void)[] = [];
    api.get.mockImplementation((url: string) =>
      url.includes("/comments")
        ? new Promise((resolve) => pending.push(resolve))
        : Promise.resolve([])
    );
    const view = render(<Comments projectId="TP" taskId="t1" />);
    view.rerender(<Comments projectId="TP" taskId="t2" />);

    // t1 answers while t2 is still in flight
    await act(async () => pending[0]([]));

    expect(screen.queryByText("No comments yet")).toBeNull();
    expect(screen.getByText("Loading the comments")).toBeTruthy();
  });

  // The tab badge is fed from here, and 3 is the count of a task nobody is looking at any more
  it("withdraws the count it reported when the task changes", async () => {
    const onCountChange = vi.fn();
    serve([comment]);
    const view = render(<Comments projectId="TP" taskId="t1" onCountChange={onCountChange} />);
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1));

    api.get.mockImplementation(() => new Promise(() => {}));
    view.rerender(<Comments projectId="TP" taskId="t2" onCountChange={onCountChange} />);

    expect(onCountChange).toHaveBeenLastCalledWith(null);
  });

  // Without this control the failure branch could be rendering whenever the list is empty
  it("still says there are none when the read answers with none", async () => {
    serve([]);
    render(<Comments projectId="TP" taskId="t1" />);

    await waitFor(() => expect(screen.getByText("No comments yet")).toBeTruthy());
    expect(screen.queryByTestId("comments-error")).toBeNull();
  });
});
