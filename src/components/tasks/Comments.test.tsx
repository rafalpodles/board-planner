// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { Comments } from "./Comments";

const { api, auth } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  auth: { user: { _id: "u1", username: "rpo", fullName: "Rafal Podles" } },
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
    expect(screen.getByTitle(/Unknown/)).toBeTruthy();
  });
});

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

  it("inserts the key itself, not a markdown link", async () => {
    const box = await composer();

    fireEvent.change(box, { target: { value: "blocked by TP-" } });
    await waitFor(() => expect(screen.getByText("TP-1")).toBeTruthy());
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(box.value).toBe("blocked by TP-1 "));
  });

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
