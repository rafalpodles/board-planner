// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
