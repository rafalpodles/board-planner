// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PullRequestBadge, PullRequestState, pullRequestLook, pullRequestSummary } from "./PullRequestBadge";
import type { ApiLinkedPR, CiState } from "@/types";

/**
 * BP-443. Six states on one badge, and two of them — green and red — are the pair colour blindness
 * separates worst at this size, so what is asserted here is the glyph and the sentence rather than
 * the hue. The look is also what the e2e reads, through `data-look`.
 */

const pr = (over: Partial<ApiLinkedPR> = {}): ApiLinkedPR =>
  ({
    _id: "l1",
    provider: "github",
    number: 12,
    title: "Keep the header visible",
    state: "open",
    url: "https://github.com/o/r/pull/12",
    mergedAt: null,
    updatedAt: "2026-09-01T00:00:00Z",
    ...over,
  }) as ApiLinkedPR;

afterEach(cleanup);

describe("what the badge decides to show", () => {
  it("lets the pull request's own state outrank whatever CI said", () => {
    // A red check on work that shipped last week is not news, and the badge that says "merged" is
    expect(pullRequestLook(pr({ state: "merged", ci: "failure" }))).toBe("merged");
    expect(pullRequestLook(pr({ state: "closed", ci: "running" }))).toBe("closed");
  });

  it("shows CI only while the pull request is open", () => {
    for (const ci of ["running", "success", "failure", "unknown"] as CiState[]) {
      expect(pullRequestLook(pr({ state: "open", ci })), ci).toBe(ci);
    }
  });

  // Every link stored before this ticket, and every GitLab link, has no `ci` at all
  it("reads a link with nothing recorded as simply open", () => {
    expect(pullRequestLook(pr({ ci: undefined }))).toBe("open");
    expect(pullRequestLook(pr({ ci: "none" }))).toBe("open");
  });
});

describe("the sentence it carries", () => {
  it("names the check that decided the state", () => {
    expect(pullRequestSummary(pr({ ci: "failure", ciLabel: "e2e" }))).toBe(
      "#12 Keep the header visible — e2e failed"
    );
    expect(pullRequestSummary(pr({ ci: "success", ciLabel: "e2e" }))).toContain("e2e passed");
    expect(pullRequestSummary(pr({ ci: "running", ciLabel: "e2e" }))).toContain("e2e running");
  });

  it("still says what happened when nothing named the check", () => {
    expect(pullRequestSummary(pr({ ci: "failure", ciLabel: null }))).toContain("checks failed");
  });

  // The whole reason `unknown` is a state of its own: a reader who cannot tell it from "nothing
  // has run" reads a broken token as a quiet board
  it("says plainly that the checks could not be read", () => {
    expect(pullRequestSummary(pr({ ci: "unknown" }))).toContain("could not be read");
    expect(pullRequestSummary(pr({ ci: "none" }))).not.toContain("could not be read");
  });
});

describe("the badge on the board", () => {
  it("opens the pull request in a new tab", () => {
    render(<PullRequestBadge pr={pr()} />);
    const badge = screen.getByRole("link");

    expect(badge.getAttribute("href")).toBe("https://github.com/o/r/pull/12");
    expect(badge.getAttribute("target")).toBe("_blank");
    expect(badge.getAttribute("rel")).toContain("noopener");
  });

  /**
   * The card underneath is itself a link and a drag handle. Without the stop, one click both opens
   * GitHub and opens the task — and a drag started on the badge drags nothing.
   */
  it("does not let the click reach the card it sits on", () => {
    let reachedTheCard = false;
    render(
      <div onClick={() => (reachedTheCard = true)}>
        <PullRequestBadge pr={pr()} />
      </div>
    );
    const badge = screen.getByRole("link");
    badge.addEventListener("click", (event) => event.preventDefault());
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(reachedTheCard).toBe(false);
  });

  it("is reachable by its sentence rather than by its colour", () => {
    render(<PullRequestBadge pr={pr({ ci: "failure", ciLabel: "e2e" })} />);

    expect(screen.getByRole("link", { name: /e2e failed/ })).toBeTruthy();
  });

  // Shape, not hue: the two CI outcomes must differ by something a reader with red/green colour
  // blindness can see, and the running state must survive prefers-reduced-motion
  it("gives each state a glyph of its own", () => {
    const glyphs = (["success", "failure", "running", "unknown"] as CiState[]).map((ci) => {
      cleanup();
      render(<PullRequestBadge pr={pr({ ci })} />);
      return screen.getByTestId("pr-badge").textContent;
    });

    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("keeps the running state visible when motion is unwelcome", () => {
    render(<PullRequestBadge pr={pr({ ci: "running" })} />);
    const pulsing = screen.getByTestId("pr-badge").querySelector(".animate-pulse");

    expect(pulsing?.className).toContain("motion-reduce:animate-none");
  });
});

describe("the badge inside the task detail's row", () => {
  // That row is already a link to the pull request, and an anchor inside an anchor is markup no
  // two browsers agree on
  it("is not itself a link", () => {
    render(<PullRequestState pr={pr()} />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByTestId("pr-state")).toBeTruthy();
  });

  it("still says what it means to a screen reader", () => {
    render(<PullRequestState pr={pr({ ci: "failure", ciLabel: "e2e" })} />);

    expect(screen.getByText(/e2e failed/)).toBeTruthy();
  });
});
