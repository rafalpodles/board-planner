// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import { LinkedWork } from "./LinkedWork";
import type { ApiTask } from "@/types";

/**
 * BP-443. The manual refresh, and the one thing about it worth pinning: what it calls is the
 * project's sync, because there is no per-pull-request endpoint and one request to GitHub answers
 * for every open branch anyway.
 */

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/components/tasks/TaskLinks", () => ({ TaskLinks: () => <div /> }));

const task = (over: Partial<ApiTask> = {}) =>
  ({
    _id: "t1",
    taskNumber: 5,
    title: "A task",
    linkedPRs: [
      {
        _id: "l1",
        provider: "github",
        number: 12,
        title: "Keep the header visible",
        state: "open",
        url: "https://github.com/o/r/pull/12",
        mergedAt: null,
        updatedAt: "2026-09-01T00:00:00Z",
        ci: "failure",
        ciLabel: "e2e",
      },
    ],
    ...over,
  }) as unknown as ApiTask;

function renderSection(over: Partial<React.ComponentProps<typeof LinkedWork>> = {}) {
  const onChanged = vi.fn();
  render(
    <LinkedWork
      projectId="p1"
      projectKey="BP"
      task={task()}
      columns={[]}
      onChanged={onChanged}
      onAddChild={() => {}}
      {...over}
    />
  );
  return { onChanged };
}

const clickRefresh = async () =>
  act(async () => {
    screen.getByRole("button", { name: /Refresh PR status/ }).click();
  });

beforeEach(() => {
  vi.clearAllMocks();
  api.post.mockResolvedValue({ synced: true });
});

afterEach(cleanup);

describe("the linked pull request", () => {
  it("shows what CI said, next to the link to the pull request", () => {
    renderSection();

    expect(screen.getByRole("link").getAttribute("href")).toBe("https://github.com/o/r/pull/12");
    expect(screen.getByTestId("pr-state").getAttribute("data-look")).toBe("failure");
    // In words on the row, not only in a tooltip — and said once, not twice
    expect(screen.getByText("e2e failed")).toBeTruthy();
  });

  // There is nothing to refresh the status of until something is linked
  it("offers no refresh when nothing is linked", () => {
    renderSection({ task: task({ linkedPRs: [] }) });

    expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
  });

  /**
   * GitLab has its own sync, in project settings. The button used to appear here and POST to the
   * GitHub endpoint, which answered "…is not a GitHub repository" every time — a correct sentence
   * under a wrong label.
   */
  it("offers no refresh when every link is GitLab's", () => {
    const merge = { ...(task().linkedPRs ?? [])[0], provider: "gitlab" };
    renderSection({ task: task({ linkedPRs: [merge] } as never) });

    expect(screen.getByTestId("pr-state")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
  });
});

describe("refreshing", () => {
  /**
   * One GitHub request answers for every open branch, so the links that come back are the
   * project's — but `taskNumber` is what keeps the merged-to-ready_to_test move to this task.
   * Without it a button called "Refresh PR status" moved other people's tasks between columns,
   * under the clicking user's name.
   */
  it("asks the project's sync, but names the task it is allowed to move", async () => {
    const { onChanged } = renderSection();

    await clickRefresh();

    expect(api.post).toHaveBeenCalledWith("/api/projects/p1/github/sync", { taskNumber: 5 });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  // A refresh that found nothing is otherwise indistinguishable from a button that did nothing
  it("says it worked, and says when the task moved", async () => {
    api.post.mockResolvedValue({ prsLinked: 1, autoTransitioned: 0 });
    renderSection();
    await clickRefresh();
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Pull requests refreshed", "success"));

    api.post.mockResolvedValue({ prsLinked: 1, autoTransitioned: 1 });
    await clickRefresh();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Pull requests refreshed — this task moved to Ready to Test",
        "success"
      )
    );
  });

  /**
   * An unconfigured token and an unreachable GitHub send somebody to different places, and the
   * route already says which — so the message it gave is the one shown, not a sentence of ours.
   */
  it("shows the reason the sync gave rather than a generic one", async () => {
    api.post.mockRejectedValue(new Error("A repository URL and a GitHub token must be configured"));
    const { onChanged } = renderSection();

    await clickRefresh();

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "A repository URL and a GitHub token must be configured",
        "error"
      )
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  // A sync is a network round trip over somebody else's API; the button has to say it is busy and
  // refuse a second click while it is
  it("says it is working, and comes back afterwards", async () => {
    let finish: (v: unknown) => void = () => {};
    api.post.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderSection();

    await clickRefresh();
    const button = screen.getByRole("button", { name: /Refreshing/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => finish({}));
    await waitFor(() => expect(screen.getByRole("button", { name: /Refresh PR status/ })).toBeTruthy());
  });
});
