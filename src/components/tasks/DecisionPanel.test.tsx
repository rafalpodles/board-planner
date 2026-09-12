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
    expect(screen.getByRole("button", { name: /Give up/ })).toBeTruthy();
  });

  it("says nothing about liveness while the machine is answering promptly", () => {
    panel({ state: "accepted" });

    expect(screen.queryByTestId("decision-machine-quiet")).toBeNull();
  });

  /**
   * Across every live state, including the one waiting on a person — which is the opposite of what
   * the first round of this review asked for, and the second round was right. On `pending` the
   * panel offers Decline and Give up side by side, both saying "delete", and the only thing
   * separating them is whether that machine is coming back.
   */
  it.each(["pending", "refused", "failed"] as const)(
    "says the machine has gone quiet while it is %s too, because that is what decides the choice",
    (state) => {
      panel({ state, workerLastSeenAt: new Date(NOW - 60 * 60_000).toISOString() });

      expect(screen.getByTestId("decision-machine-quiet")).toBeTruthy();
    }
  );

  // The control: a machine answering promptly says nothing, in any state
  it.each(["pending", "accepted"] as const)("says nothing while it is %s and alive", (state) => {
    panel({ state });

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
      // The control: a settled record still SAYS what happened. Without this the same assertion
      // passes on a panel that has vanished, taking the headline and the pull request with it.
      expect(screen.getByTestId("decision-headline").textContent).toBeTruthy();
      expect(screen.getByTestId("decision-patch")).toBeTruthy();
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

/**
 * Every one of these was a sentence contradicting the headline a few pixels above it, which reads
 * as a bug in the product rather than as a caption.
 */
describe("what it stops saying once the answer is in", () => {
  it.each(["delivered", "discarded", "abandoned", "superseded"] as const)(
    "does not still claim the work is in a worktree when it is %s",
    (state) => {
      panel({ state });

      expect(screen.getByTestId("decision-panel").textContent).not.toContain(
        "The branch was not pushed"
      );
    }
  );

  it("says where the work is while that is still true", () => {
    panel();

    expect(screen.getByTestId("decision-panel").textContent).toContain("The branch was not pushed");
  });

  // Worst instance: a pending record nobody may accept, which offers no Accept button either
  it("does not say what accepting pushes when accepting is not on offer", () => {
    panel({ acceptable: false, unacceptableReason: "it edits what CI itself does" });

    expect(screen.queryByTestId("decision-file-count")).toBeNull();
  });

  it.each(["delivered", "declined", "superseded"] as const)(
    "does not say what accepting pushes once it is %s",
    (state) => {
      panel({ state });

      expect(screen.queryByTestId("decision-file-count")).toBeNull();
    }
  );
});

/**
 * `sweepMarkers` treats a decision that has left the live list exactly as it treats a declined one:
 * the worktree goes. Giving up was the least emphatic control on the panel, named nothing, and
 * asked nothing — while doing what the button beside it spells out.
 */
describe("giving up", () => {
  it("says it deletes the work, and asks first", async () => {
    panel();

    fireEvent.click(screen.getByRole("button", { name: "Give up and delete the work" }));

    expect(screen.getByRole("dialog").textContent).toContain("worktree holding this change is deleted");
    expect(post).not.toHaveBeenCalled();
  });

  it("posts only once confirmed", async () => {
    panel();

    fireEvent.click(screen.getByRole("button", { name: "Give up and delete the work" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Give up and delete" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/projects/p1/tasks/t1/decision", {
        verdict: "abandon",
      })
    );
  });

  // Every live state, because the machine can stop answering at any of them
  it.each(["pending", "accepted", "declined", "refused", "failed"] as const)(
    "is offered while it is %s",
    (state) => {
      panel({ state });

      expect(screen.getByRole("button", { name: "Give up and delete the work" })).toBeTruthy();
    }
  );
});

/**
 * The task screen does not poll. Without this the panel sits on "waiting for the machine to push
 * it" for ever: the pull request, the refusal and the error all arrive on a reload nobody knows to
 * do.
 */
describe("while the verdict is with the machine", () => {
  it.each(["accepted", "declined"] as const)("re-reads the task while it is %s", (state) => {
    const onAnswered = panel({ state });

    vi.advanceTimersByTime(10_000);

    expect(onAnswered).toHaveBeenCalled();
  });

  it.each(["pending", "delivered", "discarded"] as const)(
    "leaves the task alone while it is %s",
    (state) => {
      const onAnswered = panel({ state });

      vi.advanceTimersByTime(60_000);

      expect(onAnswered).not.toHaveBeenCalled();
    }
  );
});

describe("the change itself", () => {
  // The app hides every scrollbar globally, so a wheel is otherwise the only way into the panel's
  // primary reading surface
  it("is a named region a keyboard can reach once it scrolls", () => {
    panel({ patch: "diff\n".repeat(500) });
    const pre = screen.getByTestId("decision-patch");

    expect(pre.className).toContain("focus-ring");
    // Wrapped rather than scrolled sideways: a long diff line is unreachable otherwise
    expect(pre.className).toContain("whitespace-pre-wrap");
  });

  /**
   * The tab stop and the name are both conditional on there being something to scroll to, and they
   * go together: a name on a role-less element is ignored by some assistive technology and
   * suppresses the content in others. happy-dom reports no layout, so this drives the measurement
   * rather than waiting for one.
   */
  it("names itself as a region exactly when it takes a tab stop", () => {
    panel();
    const pre = screen.getByTestId("decision-patch");
    const scrollable = pre.getAttribute("tabindex") === "0";

    expect(pre.getAttribute("role")).toBe(scrollable ? "region" : null);
    expect(pre.getAttribute("aria-label")).toBe(scrollable ? "The refused change" : null);
  });
});

/**
 * The verdict is pinned to the record this screen read, so a refusal means what is on screen is not
 * what is there any more — a superseded patch, its file list, and a live Accept button over a change
 * that no longer exists.
 */
describe("when the verdict is refused", () => {
  it("re-reads the task rather than leaving the stale record up", async () => {
    post.mockRejectedValue(new Error("no longer the one you read"));
    const onAnswered = panel();

    fireEvent.click(screen.getByRole("button", { name: "Decline and delete" }));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });
});

/**
 * `loadData` fetches three endpoints, so a poll that never stops is three requests every ten
 * seconds per open tab, for ever — and a machine that was re-imaged or switched off stays
 * `accepted` for ever. The moment it becomes pointless is the moment the panel already computes.
 */
describe("when the machine is not coming back", () => {
  it("stops polling once it has gone quiet", () => {
    const onAnswered = panel({
      state: "accepted",
      workerLastSeenAt: new Date(NOW - 30 * 60_000).toISOString(),
    });

    vi.advanceTimersByTime(120_000);

    expect(onAnswered).not.toHaveBeenCalled();
    // The control: the panel says why, and offers the way out
    expect(screen.getByTestId("decision-machine-quiet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Give up and delete the work" })).toBeTruthy();
  });
});

/**
 * Giving up means three different things, and one sentence saying "stops waiting for an answer"
 * is simply false on the two states where it is the only button.
 */
describe("what giving up is warned to cost", () => {
  it.each([
    ["pending", "stops waiting for an answer"],
    ["accepted", "may be pushing it right now"],
    ["declined", "is removing it"],
  ] as const)("describes the moment it is offered at, on %s", (state, said) => {
    panel({ state });

    fireEvent.click(screen.getByRole("button", { name: "Give up and delete the work" }));

    expect(screen.getByRole("dialog").textContent).toContain(said);
  });

  // Whatever the moment, it always says what happens to the work
  it.each(["pending", "accepted", "declined"] as const)("always says the work goes, on %s", (state) => {
    panel({ state });

    fireEvent.click(screen.getByRole("button", { name: "Give up and delete the work" }));

    expect(screen.getByRole("dialog").textContent).toContain("deleted");
  });
});
