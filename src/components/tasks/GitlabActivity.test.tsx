// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { GitlabActivity } from "./GitlabActivity";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));

const branch = {
  name: "TP-3/mirror-the-fix",
  url: "https://gitlab.example.com/g/p/-/tree/TP-3/mirror-the-fix",
  lastCommitAt: "2026-08-01T00:00:00Z",
};
const commit = {
  shortId: "a1b2c3d4",
  title: "TP-3 mirror the fix",
  authorName: "Ada Lovelace",
  url: "https://gitlab.example.com/g/p/-/commit/a1b2c3d4e5f6",
  createdAt: "2026-08-01T00:00:00Z",
};

async function renderSettled(answer: () => Promise<unknown>) {
  let settled: Promise<unknown> = Promise.resolve();
  api.get.mockImplementation(() => {
    settled = answer();
    return settled;
  });
  const view = render(<GitlabActivity projectId="TP" taskId="t1" />);
  await act(async () => {
    await settled.catch(() => {});
  });
  expect(api.get).toHaveBeenCalledWith("/api/projects/TP/tasks/t1/gitlab-activity");
  return view;
}

beforeEach(() => {
  api.get.mockReset();
});

afterEach(cleanup);

describe("GitlabActivity", () => {
  it("lists the task's branches and commits as links", async () => {
    await renderSettled(async () => ({
      configured: true,
      branches: [branch],
      commits: [commit],
      partialError: null,
    }));

    expect(screen.getByRole("heading", { name: "GitLab activity" })).toBeTruthy();
    expect(screen.getByText("Branches (1)")).toBeTruthy();
    expect(screen.getByText("Commits (1)")).toBeTruthy();
    expect(screen.getByRole("link", { name: /TP-3\/mirror-the-fix/ }).getAttribute("href")).toBe(
      branch.url
    );
    const commitLink = screen.getByRole("link", { name: /a1b2c3d4/ });
    expect(commitLink.getAttribute("href")).toBe(commit.url);
    expect(commitLink.textContent).toContain(commit.title);
    expect(commitLink.textContent).toContain(commit.authorName);
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it("names the half that failed and still shows the half that loaded", async () => {
    await renderSettled(async () => ({
      configured: true,
      branches: [branch],
      commits: [],
      partialError: "Could not load commits",
    }));

    expect(screen.getByText("Could not load commits")).toBeTruthy();
    expect(screen.getByText("Branches (1)")).toBeTruthy();
    expect(screen.queryByText(/Commits \(/)).toBeNull();
  });

  it("renders nothing for a project with no GitLab repository", async () => {
    const { container } = await renderSettled(async () => ({
      configured: false,
      branches: [],
      commits: [],
    }));

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when GitLab has nothing for this task", async () => {
    const { container } = await renderSettled(async () => ({
      configured: true,
      branches: [],
      commits: [],
      partialError: null,
    }));

    expect(container.innerHTML).toBe("");
  });

  it("shows the error when the request itself fails", async () => {
    await renderSettled(async () => {
      throw new Error("GitLab request failed");
    });

    expect(screen.getByRole("heading", { name: "GitLab activity" })).toBeTruthy();
    expect(screen.getByText("GitLab request failed")).toBeTruthy();
  });
});
