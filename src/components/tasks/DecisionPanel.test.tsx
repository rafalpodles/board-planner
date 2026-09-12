// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import { ApiTaskDecision } from "@/types";

const post = vi.fn();
const get = vi.fn();
const toast = vi.fn();
vi.mock("@/hooks/use-api", () => ({ useApi: () => ({ post, get }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const { DecisionPanel } = await import("./DecisionPanel");

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const PRESUMED_GONE_MS = 10 * 60_000;

/**
 * The whole record as the API serialises it. Built from the wire shape rather than from what the
 * panel happens to read, so a field the panel must NOT surface still reaches it.
 */
function decision(over: Partial<ApiTaskDecision> = {}): ApiTaskDecision {
  return {
    gate: "protected-paths",
    fileCount: 3,
    protectedFiles: ["package.json"],
    protectedFileCount: 1,
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
  // The poll's own read. Answering with the state the panel already has is the quiet case.
  get.mockResolvedValue({ decision: { state: "accepted" } });
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

  /**
   * Both lists are bounded by the route that stores them and both counts are not, so the panel has
   * to render the counts — otherwise a seven-hundred-file change reads as five hundred on the one
   * sentence whose job is to say how much is being consented to.
   */
  it("says how many files there really are, not how many it was given", () => {
    panel({ fileCount: 700 });

    expect(screen.getByTestId("decision-file-count").textContent).toContain("700 files");
  });

  it("says how many more tripped the gate than it can show", () => {
    panel({ protectedFiles: ["package.json"], protectedFileCount: 600 });

    expect(screen.getByTestId("decision-protected-files").textContent).toContain("and 599 more");
  });

  // The control: nothing extra when the list is whole
  it("says nothing about more when it is showing all of them", () => {
    panel();

    expect(screen.getByTestId("decision-protected-files").textContent).not.toContain("more");
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
    // Whose account it spends, which is the half a machine name alone hides — and it is not
    // "the owner's" either: a machine with nothing pinned pushes as whatever gh has active
    expect(screen.getByText(/whichever GitHub account/)).toBeTruthy();
    expect(screen.getByText(/not necessarily yours/)).toBeTruthy();
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

  /**
   * The label names what the BOARD does, and the body carries the machine's part. It used to say
   * "Decline and delete" — an unconditional promise, and falsest in the case Give up is named for,
   * since a machine that is not coming back never polls and so never removes anything.
   */
  it("names what the board does, not a deletion it cannot promise", () => {
    panel();

    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Give up" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("declines without a dialog — nothing is spent by saying no", async () => {
    panel();

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/projects/p1/tasks/t1/decision", { verdict: "decline" })
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the refusal rather than swallowing it", async () => {
    post.mockRejectedValue(new Error("already answered"));
    panel();

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

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

    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
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

  /**
   * With the verb. A bare name and date directly above the buttons reads as the reporter or the
   * assignee; it means somebody ANSWERED this, and the answer differs per state.
   */
  it.each([
    ["accepted", "Accepted by Rafal"],
    ["delivered", "Accepted by Rafal"],
    ["failed", "Accepted by Rafal"],
    ["declined", "Declined by Rafal"],
    ["discarded", "Declined by Rafal"],
    ["abandoned", "Given up by Rafal"],
  ] as const)("says what %s means the person did", (state, said) => {
    panel({
      state,
      decidedBy: { _id: "u1", username: "owner", fullName: "Rafal" },
      decidedAt: new Date(NOW - 1000).toISOString(),
    });

    expect(screen.getByTestId("decision-decided-by").textContent).toContain(said);
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

    fireEvent.click(screen.getByRole("button", { name: "Give up" }));

    expect(screen.getByRole("dialog").textContent).toContain("removes the worktree");
    expect(post).not.toHaveBeenCalled();
  });

  it("posts only once confirmed", async () => {
    panel();

    fireEvent.click(screen.getByRole("button", { name: "Give up" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Give up on it" }));

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

      expect(screen.getByRole("button", { name: "Give up" })).toBeTruthy();
    }
  );
});

/**
 * The task screen does not poll. Without this the panel sits on "waiting for the machine to push
 * it" for ever: the pull request, the refusal and the error all arrive on a reload nobody knows to
 * do.
 */
describe("while the verdict is with the machine", () => {
  it.each(["accepted", "declined"] as const)("asks what became of it while it is %s", (state) => {
    panel({ state });

    vi.advanceTimersByTime(10_000);

    expect(get).toHaveBeenCalledWith("/api/projects/p1/tasks/t1/decision");
  });

  it.each(["pending", "delivered", "discarded"] as const)(
    "asks nothing while it is %s",
    (state) => {
      panel({ state });

      vi.advanceTimersByTime(60_000);

      expect(get).not.toHaveBeenCalled();
    }
  );

  /**
   * The narrow read, not the whole task: the task-detail route selects the patch, which is up to
   * 220 KB and does not change. A full reload is worth it only once the answer has moved.
   */
  it("re-reads the whole task only when the answer has actually moved", async () => {
    get.mockResolvedValue({ decision: { state: "delivered" } });
    const onAnswered = panel({ state: "accepted" });

    vi.advanceTimersByTime(10_000);

    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });

  /**
   * `advanceTimersByTimeAsync`, not one `Promise.resolve()`: three polls fire in thirty seconds and
   * each awaits `api.get`, so a single microtask drains one link of the chain rather than the
   * chain. The positive case above needs `waitFor` to SEE its effect — a negative settled sooner
   * than that has excluded nothing.
   */
  it("leaves the task alone while the answer is where it was", async () => {
    get.mockResolvedValue({ decision: { state: "accepted" } });
    const onAnswered = panel({ state: "accepted" });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(get).toHaveBeenCalledTimes(3);
    expect(onAnswered).not.toHaveBeenCalled();
  });

  // A poll that cannot reach the server says nothing rather than toasting once every ten seconds
  it("says nothing when the poll fails", async () => {
    get.mockRejectedValue(new Error("offline"));
    panel({ state: "accepted" });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(get).toHaveBeenCalledTimes(3);
    expect(toast).not.toHaveBeenCalled();
  });
});

/**
 * The app hides every scrollbar globally, so a wheel is otherwise the only way into the panel's
 * primary reading surface.
 *
 * happy-dom reports no layout — `scrollHeight` and `clientHeight` are both 0 — so a test that
 * merely renders can never see the tab stop appear. These define the two properties rather than
 * waiting for a layout engine that is not there.
 */
describe("the change itself", () => {
  function withScrollHeight(height: number, clientHeight: number) {
    Object.defineProperty(HTMLPreElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => height,
    });
    Object.defineProperty(HTMLPreElement.prototype, "clientHeight", {
      configurable: true,
      get: () => clientHeight,
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(HTMLPreElement.prototype, "scrollHeight");
    Reflect.deleteProperty(HTMLPreElement.prototype, "clientHeight");
  });

  it("wraps rather than scrolling sideways, and takes the focus ring", () => {
    panel();
    const pre = screen.getByTestId("decision-patch");

    expect(pre.className).toContain("focus-ring");
    expect(pre.className).toContain("whitespace-pre-wrap");
  });

  it("takes a tab stop and names itself once there is something to scroll to", async () => {
    withScrollHeight(900, 380);
    panel();

    const pre = screen.getByTestId("decision-patch");
    await waitFor(() => expect(pre.getAttribute("tabindex")).toBe("0"));
    expect(pre.getAttribute("role")).toBe("region");
    expect(pre.getAttribute("aria-label")).toBe("The refused change");
  });

  /**
   * A tab stop on something that does not scroll is a stop with nothing to do, and a name on a
   * role-less element is ignored by some assistive technology and suppresses the content in
   * others — so the two go together, in both directions.
   */
  it("takes neither when the whole change already fits", async () => {
    withScrollHeight(200, 380);
    panel();

    const pre = screen.getByTestId("decision-patch");
    await waitFor(() => expect(pre.getAttribute("tabindex")).toBeNull());
    expect(pre.getAttribute("role")).toBeNull();
    expect(pre.getAttribute("aria-label")).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

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
  /**
   * `Date.now()` is lifted into state so the ten-minute mark can arrive while somebody is looking
   * at the panel. Read at render time it would only ever arrive on a reload — which for a person
   * waiting on a machine that is never coming back is the one thing they do not know to do.
   */
  it("notices the machine going quiet while the panel is open", async () => {
    panel({ state: "accepted", workerLastSeenAt: new Date(NOW - 60_000).toISOString() });
    expect(screen.queryByTestId("decision-machine-quiet")).toBeNull();

    vi.advanceTimersByTime(PRESUMED_GONE_MS);

    await waitFor(() => expect(screen.getByTestId("decision-machine-quiet")).toBeTruthy());
  });

  /**
   * Backed off rather than stopped. The poll is the only thing that refreshes the record, so
   * stopping freezes `workerLastSeenAt` with it and the panel can never learn that the machine
   * came back — leaving "waiting for the machine to push it" over a pull request that is already
   * open. And ten minutes of silence is not death: this repository's own rule is that staleness is
   * not judged by silence, and the execution lease is two hours.
   */
  it("backs off rather than stopping, so a machine that comes back is still noticed", () => {
    panel({
      state: "accepted",
      workerLastSeenAt: new Date(NOW - 30 * 60_000).toISOString(),
    });

    vi.advanceTimersByTime(10_000);
    expect(get).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50_000);
    expect(get).toHaveBeenCalledTimes(1);

    // The control: the panel says why, and offers the way out
    expect(screen.getByTestId("decision-machine-quiet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Give up" })).toBeTruthy();
  });

  // The control for the one above: while the machine is answering, the fast interval is the one
  it("keeps the fast interval while the machine is alive", () => {
    panel({ state: "accepted" });

    vi.advanceTimersByTime(10_000);

    expect(get).toHaveBeenCalledTimes(1);
  });
});

/**
 * Giving up means three different things, and one sentence saying "stops waiting for an answer"
 * is simply false on the two states where it is the only button.
 */
describe("what giving up is warned to cost", () => {
  it.each([
    ["pending", "withdraws the question"],
    ["accepted", "may be pushing it right now"],
    ["declined", "is removing it"],
  ] as const)("describes the moment it is offered at, on %s", (state, said) => {
    panel({ state });

    fireEvent.click(screen.getByRole("button", { name: "Give up" }));

    expect(screen.getByRole("dialog").textContent).toContain(said);
  });

  /**
   * Whatever the moment, it says who removes the worktree and when — which is the machine, on its
   * next poll. The promise "the worktree is deleted" is least true in the case this button is
   * named for: a machine that is not coming back never polls.
   */
  it.each(["pending", "accepted", "declined"] as const)(
    "says the deletion is the machine's own, on %s",
    (state) => {
      panel({ state });

      fireEvent.click(screen.getByRole("button", { name: "Give up" }));

      const said = screen.getByRole("dialog").textContent ?? "";
      // The machine's real name, verbatim. Capitalising whatever `workerName` holds — rather than
      // only the fallback that starts a sentence — turned `e2e-macbook-pro` into
      // `E2e-macbook-pro`, and every assertion here matched a substring after the name, so
      // nothing could see it.
      expect(said).toContain("e2e-macbook-pro removes the worktree on its next poll");
      // "worktree", not "checkout": what is left behind is the linked worktree under the worker's
      // own root, and this product uses "checkout" for the clone the operator approved
      expect(said).toContain("worktree stays on that machine until somebody removes it");
    }
  );
});

/**
 * Decline is the one verdict with no dialog, so its only feedback was a word on a button that had
 * just left the tab order — outside the live region, announced to nobody.
 */
describe("while a verdict is in flight", () => {
  it("announces declining in the live region", async () => {
    let resolvePost: (value: unknown) => void = () => {};
    post.mockReturnValue(new Promise((resolve) => (resolvePost = resolve)));
    panel();

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    // Scoped to the live region: the button says it too, and the button is what is NOT announced
    const live = screen.getByRole("status");
    await waitFor(() => expect(within(live).getByText("Declining...")).toBeTruthy());
    resolvePost({});
  });
});

/**
 * A clipped URL is the worst of both — unreadable, and a poor accessible name. Parsing `#42` out of
 * it would mean owning GitHub and GitLab url shapes in a panel, for a number.
 */
describe("the pull request it opened", () => {
  it("is a named link rather than a clipped url", () => {
    panel({ state: "delivered", prUrl: "https://github.com/owner/repo/pull/42" });
    const link = screen.getByTestId("decision-pr");

    expect(link.textContent).toBe("Open the pull request on github.com");
    expect(link.getAttribute("href")).toBe("https://github.com/owner/repo/pull/42");
    expect(link.getAttribute("title")).toBe("https://github.com/owner/repo/pull/42");
  });

  /**
   * The url is worker-supplied. Its shape is checked server-side and its host is not — and the
   * visible url was what let a reader notice an odd one, so the host has to stay where a person,
   * a touch screen and a screen reader can all reach it.
   */
  it("says where it goes, so an unexpected host is visible rather than hovered", () => {
    panel({ state: "delivered", prUrl: "https://ghe.internal:8443/owner/repo/pull/7" });

    expect(screen.getByTestId("decision-pr").textContent).toContain("ghe.internal:8443");
  });
});

/**
 * `presumedGone` covers every live state, but only `accepted`/`declined` poll — so on the three
 * states where nobody polls the warning was frozen at whatever it said when the panel mounted. On
 * `pending` that is the state most in need of it: whether the machine is coming back is the whole
 * of what separates Decline from Give up.
 */
describe("the liveness clock on a record waiting for a person", () => {
  it.each(["pending", "refused", "failed"] as const)(
    "notices the machine going quiet while %s is on screen",
    async (state) => {
      panel({ state, workerLastSeenAt: new Date(NOW - 60_000).toISOString() });
      expect(screen.queryByTestId("decision-machine-quiet")).toBeNull();

      await vi.advanceTimersByTimeAsync(PRESUMED_GONE_MS);

      await waitFor(() => expect(screen.getByTestId("decision-machine-quiet")).toBeTruthy());
    }
  );

  // The control: it advances a clock, it does not start asking the server anything
  it("does not poll on a record waiting for a person", async () => {
    panel({ state: "pending" });

    await vi.advanceTimersByTimeAsync(PRESUMED_GONE_MS);

    expect(get).not.toHaveBeenCalled();
  });
});

/**
 * The poll already fetches `workerLastSeenAt` and used to throw it away, so the panel went on
 * saying "may never see this" over a machine that had come back and was mid-push — because the
 * state had not moved yet.
 */
describe("a machine that comes back", () => {
  it("re-reads the task when it is heard from again, even with the state unmoved", async () => {
    get.mockResolvedValue({
      decision: { state: "accepted", workerLastSeenAt: new Date(NOW).toISOString() },
    });
    const onAnswered = panel({
      state: "accepted",
      workerLastSeenAt: new Date(NOW - 30 * 60_000).toISOString(),
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(onAnswered).toHaveBeenCalled();
  });
});

// "Accepting pushes…" points at a verb nothing offers when the button says "Try again"
describe("what the file count is named for", () => {
  it.each([
    ["pending", "Accepting pushes the whole commit"],
    ["refused", "Trying again pushes the whole commit"],
    ["failed", "Trying again pushes the whole commit"],
  ] as const)("matches the button on %s", (state, said) => {
    panel({ state });

    expect(screen.getByTestId("decision-file-count").textContent).toContain(said);
  });
});

/**
 * `workerName` is absent whenever the machine has been deleted from the fleet, and every fixture
 * in this file sets it — so the fallback rendered in production and in no test. It was capitalised
 * for the one sentence that starts with it, and read as "…and That machine may be pushing it right
 * now" in the two that do not.
 */
describe("a machine the fleet no longer names", () => {
  it("reads as a sentence wherever it lands", () => {
    panel({ state: "accepted", workerName: undefined });

    fireEvent.click(screen.getByRole("button", { name: "Give up" }));
    const said = screen.getByRole("dialog").textContent ?? "";

    expect(said).toContain("accepted and that machine may be pushing it");
    expect(said).toContain("That machine removes the worktree");
    expect(said).not.toContain("and That machine");
  });

  it("still says whose account the push spends", () => {
    panel({ workerName: undefined });

    fireEvent.click(screen.getByRole("button", { name: "Accept and push" }));

    expect(screen.getByRole("dialog").textContent).toContain(
      "whichever GitHub account that machine pushes as"
    );
  });

  // The panel falls back for the byline too, rather than saying nothing about who can answer
  it("still says who may answer", () => {
    panel({ canDecide: false, workerName: undefined });

    expect(screen.getByTestId("decision-not-yours").textContent).toContain("that machine");
  });
});

/**
 * The host is in the visible text because the url is worker-supplied and its host is not checked.
 * An anchor reading "an unknown host" is the one shape that asks somebody to click without telling
 * them where — so a url the panel cannot read is not offered at all.
 */
describe("a pull request url the panel cannot read", () => {
  it("is not offered as a link", () => {
    panel({ state: "delivered", prUrl: "not a url" });

    expect(screen.queryByTestId("decision-pr")).toBeNull();
  });

  /**
   * Shown, though — dropping the address as well as the link leaves a record headlined "Pushed,
   * and a pull request is open" with nothing to reach or even read.
   */
  it("is still shown, as text, with the reason it is not a link", () => {
    panel({ state: "delivered", prUrl: "not a url" });
    const said = screen.getByTestId("decision-pr-unreadable");

    expect(said.textContent).toContain("not a url");
    expect(said.textContent).toContain("not offered as a link");
    expect(said.querySelector("a")).toBeNull();
  });

  // The control: a readable one gets the link and no explanation
  it("says nothing about recognising an address it does recognise", () => {
    panel({ state: "delivered", prUrl: "https://github.com/o/r/pull/1" });

    expect(screen.queryByTestId("decision-pr-unreadable")).toBeNull();
  });

  // The control: a real one still is
  it("is offered when it is one", () => {
    panel({ state: "delivered", prUrl: "https://github.com/o/r/pull/1" });

    expect(screen.getByTestId("decision-pr")).toBeTruthy();
  });
});

/**
 * `touchWorker` moves `lastSeenAt` on every heartbeat — every thirty seconds by default — while
 * the panel polls every ten. Comparing the value alone reloaded three endpoints, one of them
 * carrying the patch, twice a minute over a machine that was never anything but healthy.
 */
describe("a healthy machine's heartbeat", () => {
  it("does not reload the task on every poll", async () => {
    get.mockResolvedValue({
      decision: { state: "accepted", workerLastSeenAt: new Date(NOW + 5_000).toISOString() },
    });
    const onAnswered = panel({ state: "accepted" });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(get).toHaveBeenCalledTimes(3);
    expect(onAnswered).not.toHaveBeenCalled();
  });
});

/**
 * Read whole rather than as a delta: each of these was a sentence that contradicted something
 * else on the same screen, in a state the conditionals had grown past.
 */
describe("states the panel has to stay coherent in", () => {
  /**
   * `refused` and `failed` are the two where somebody DID answer — the panel says "Accepted by …"
   * two lines above the button — and the push is what did not work. The default branch was
   * written for `pending` and told them nobody had answered a change they accepted themselves.
   */
  it.each(["refused", "failed"] as const)(
    "does not tell somebody nobody answered a change they accepted, on %s",
    (state) => {
      panel({ state, error: "remote hung up" });

      fireEvent.click(screen.getByRole("button", { name: "Give up" }));
      const said = screen.getByRole("dialog").textContent ?? "";

      expect(said).toContain("accepted and the push did not go through");
      expect(said).not.toContain("Nobody has answered");
    }
  );

  /**
   * On a quiet `pending` the warning sits beside Accept and Decline, both of which are
   * instructions to a machine the panel has just said may never hear them. Nothing said which of
   * the three buttons survives a dead machine.
   */
  it("says which buttons survive a machine that may never hear them", () => {
    panel({ workerLastSeenAt: new Date(NOW - 30 * 60_000).toISOString() });

    const said = screen.getByTestId("decision-machine-quiet").textContent ?? "";
    expect(said).toContain("giving up does not");
    // The control: all three buttons really are on screen, so the sentence is about this state
    expect(screen.getByRole("button", { name: "Accept and push" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Give up" })).toBeTruthy();
  });

  // Nothing to choose between on a state the machine owns — the only button is Give up
  it("says nothing about which buttons survive where there is one", () => {
    panel({ state: "accepted", workerLastSeenAt: new Date(NOW - 30 * 60_000).toISOString() });

    expect(screen.getByTestId("decision-machine-quiet").textContent).not.toContain(
      "giving up does not"
    );
  });

  /**
   * `workerLastSeenAt` arrives only as a prop, so a state that never polls could raise the warning
   * and never lower it — over a machine that had come back, next to the buttons it argues against.
   */
  it.each(["pending", "refused", "failed"] as const)(
    "keeps asking after it has called the machine quiet, on %s",
    async (state) => {
      panel({ state, workerLastSeenAt: new Date(NOW - 30 * 60_000).toISOString() });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(get).toHaveBeenCalled();
    }
  );

  // The control: a live machine on a state a person owns is nobody's business to poll
  it("asks nothing on a live pending record", async () => {
    panel();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(get).not.toHaveBeenCalled();
  });

  // One box, one referent: the paragraph used to fall back to the worker id while the warning
  // beneath it fell back to "That machine"
  it("calls a nameless machine the same thing twice", () => {
    panel({ workerName: undefined, workerLastSeenAt: new Date(NOW - 30 * 60_000).toISOString() });

    expect(screen.getByTestId("decision-where-the-work-is").textContent).toContain("that machine");
    expect(screen.getByTestId("decision-machine-quiet").textContent).toContain("That machine");
    expect(screen.getByTestId("decision-panel").textContent).not.toContain("w1");
  });
});
