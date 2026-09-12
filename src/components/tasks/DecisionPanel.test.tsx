// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import { ApiTaskDecision } from "@/types";

const post = vi.fn();
const toast = vi.fn();
vi.mock("@/hooks/use-api", () => ({ useApi: () => ({ post }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const { DecisionPanel } = await import("./DecisionPanel");

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

/**
 * The whole record as the API serialises it. Built from the wire shape rather than from what the
 * panel happens to read, so a field the panel must NOT surface still reaches it.
 */
function decision(over: Partial<ApiTaskDecision> = {}): ApiTaskDecision {
  return {
    gate: "protected-paths",
    files: ["package.json", "src/a.ts", "src/b.ts"],
    protectedFiles: ["package.json"],
    patch: "diff --git a/package.json b/package.json\n+  \"build\": \"x\"\n",
    patchTruncated: false,
    commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    workerId: "w1",
    workerName: "e2e-macbook-pro",
    workerLastSeenAt: new Date(NOW - 5_000).toISOString(),
    taskKey: "CP-158",
    title: "Add a thing",
    acceptable: true,
    unacceptableReason: "",
    canDecide: true,
    state: "pending",
    decidedBy: null,
    decidedAt: null,
    prUrl: "",
    error: "",
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

function panel(over: Partial<ApiTaskDecision> = {}, onAnswered = vi.fn()) {
  render(
    <DecisionPanel projectId="p1" taskId="t1" decision={decision(over)} onAnswered={onAnswered} />
  );
  return onAnswered;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
  post.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("what the panel shows", () => {
  it("says nothing at all for a task that has never had a change refused", () => {
    render(<DecisionPanel projectId="p1" taskId="t1" onAnswered={vi.fn()} />);

    expect(screen.queryByTestId("decision-panel")).toBeNull();
  });

  it("names the gate, the commit and the machine holding the work", () => {
    panel();

    expect(screen.getByTestId("decision-commit").textContent).toBe("a1b2c3d4e5f6");
    expect(screen.getByTestId("decision-panel").textContent).toContain("protected-paths");
    expect(screen.getByTestId("decision-panel").textContent).toContain("e2e-macbook-pro");
  });

  it("renders the change itself, which is the thing being accepted", () => {
    panel();

    expect(screen.getByTestId("decision-patch").textContent).toContain("diff --git a/package.json");
  });

  /**
   * `protectedPaths(changedFiles)` is the subset that tripped the gate; accepting pushes the
   * commit, all of it. Saying only the hits is the sentence people get wrong.
   */
  it("separates what tripped the gate from what accepting actually pushes", () => {
    panel();

    expect(screen.getByTestId("decision-protected-files").textContent).toContain("package.json");
    expect(screen.getByTestId("decision-file-count").textContent).toContain("3 files");
  });
});

describe("what accepting consents to", () => {
  /**
   * `.github/workflows/ci.yml` is `on: push` with no branch filter and runs `npm ci` without
   * `--ignore-scripts`, so the push alone is the trigger. The decision was to keep the button and
   * make the label honest — a confirm that says "opens a pull request" and stops there would be
   * the first draft's false claim, on screen.
   */
  it("says the push runs CI, before anything is posted", async () => {
    panel();

    fireEvent.click(screen.getByRole("button", { name: "Accept and push" }));

    expect(screen.getByText(/runs this repository's CI/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it("posts the verdict once confirmed, and reloads the task", async () => {
    const onAnswered = panel();

    fireEvent.click(screen.getByRole("button", { name: "Accept and push" }));
    const confirm = screen.getByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Accept and push" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/projects/p1/tasks/t1/decision", { verdict: "accept" })
    );
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });

  it("declines without a dialog — nothing is spent by saying no", async () => {
    panel();

    fireEvent.click(screen.getByRole("button", { name: "Decline and delete" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/projects/p1/tasks/t1/decision", { verdict: "decline" })
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the refusal rather than swallowing it", async () => {
    post.mockRejectedValue(new Error("already answered"));
    panel();

    fireEvent.click(screen.getByRole("button", { name: "Decline and delete" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("already answered", "error"));
  });
});

describe("a change that may not be accepted here", () => {
  const workflow = {
    acceptable: false,
    unacceptableReason: "the change edits what CI itself does (.github/workflows/ci.yml).",
  };

  it("offers no Accept, and says why that family is different", () => {
    panel(workflow);

    expect(screen.queryByRole("button", { name: "Accept and push" })).toBeNull();
    expect(screen.getByTestId("decision-unacceptable").textContent).toContain(
      ".github/workflows/ci.yml"
    );
  });

  // The work should not sit on a laptop for ever either way
  it("still offers Decline", () => {
    panel(workflow);

    expect(screen.getByRole("button", { name: "Decline and delete" })).toBeTruthy();
  });
});

/**
 * The bar is the machine's owner or an instance admin, which is above project membership — and
 * everyone who can open the task can READ this. A button that answers 403 is worse than no button.
 */
describe("a reader who may not answer", () => {
  it("offers no buttons, and says who can", () => {
    panel({ canDecide: false });

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("decision-not-yours").textContent).toContain("e2e-macbook-pro");
  });

  it("still shows them the change", () => {
    panel({ canDecide: false });

    expect(screen.getByTestId("decision-patch")).toBeTruthy();
  });
});

describe("once it has been answered", () => {
  /**
   * A machine re-imaged, deregistered, disabled or locked never hears the verdict, so the panel
   * renders liveness from `lastSeenAt` — and giving up is what makes every stranded case
   * recoverable, including the ones nobody anticipated.
   */
  it("says the machine may never see it, when it has gone quiet", () => {
    panel({ state: "accepted", workerLastSeenAt: new Date(NOW - 30 * 60_000).toISOString() });

    expect(screen.getByTestId("decision-machine-quiet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Give up on it" })).toBeTruthy();
  });

  it("says nothing about liveness while the machine is answering promptly", () => {
    panel({ state: "accepted" });

    expect(screen.queryByTestId("decision-machine-quiet")).toBeNull();
  });

  it("links the pull request once it is open", () => {
    panel({ state: "delivered", prUrl: "https://github.com/o/r/pull/7" });

    expect(screen.getByTestId("decision-pr").getAttribute("href")).toBe(
      "https://github.com/o/r/pull/7"
    );
  });

  // Neither is a dead end: a transient fault must not cost a second reading of the same diff
  it.each(["refused", "failed"] as const)("offers another go after a %s settlement", (state) => {
    panel({ state, error: "remote hung up" });

    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByTestId("decision-error").textContent).toContain("remote hung up");
  });

  it.each(["delivered", "discarded", "abandoned", "superseded"] as const)(
    "offers nothing once it is %s",
    (state) => {
      panel({ state });

      expect(screen.queryByRole("button")).toBeNull();
    }
  );

  it("names who answered it", () => {
    panel({
      state: "accepted",
      decidedBy: { _id: "u1", username: "owner", fullName: "Rafal" },
      decidedAt: new Date(NOW - 1000).toISOString(),
    });

    expect(screen.getByTestId("decision-decided-by").textContent).toContain("Rafal");
  });
});
