// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  PullRequestBadge,
  PullRequestState,
  pullRequestLook,
  pullRequestStatusText,
  pullRequestSummary,
} from "./PullRequestBadge";
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

/** One pull request per look the badge can wear. */
const ALL_LOOKS: Partial<ApiLinkedPR>[] = [
  { state: "open" },
  { state: "open", ci: "running" },
  { state: "open", ci: "success" },
  { state: "open", ci: "failure" },
  { state: "open", ci: "unknown" },
  { state: "merged" },
  { state: "closed" },
];

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

  /**
   * The whole reason `unknown` is a state of its own: a reader who cannot tell it from "nothing has
   * run" reads an instance that cannot reach GitHub as a board where no build ever ran.
   *
   * "not read" rather than "could not be read", and the distinction is the review's: the state has
   * two causes — a request that failed, and a pull request past the sync's cap that nobody asked
   * about — and only one of them is the token's fault.
   */
  it("says the checks have not been read, without blaming the token", () => {
    expect(pullRequestSummary(pr({ ci: "unknown" }))).toContain("checks not read");
    expect(pullRequestSummary(pr({ ci: "unknown" }))).not.toContain("could not");
    expect(pullRequestSummary(pr({ ci: "none" }))).not.toContain("not read");
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

  /**
   * The list renders every linked pull request through this one, GitLab's included, so a name that
   * said "Opens on GitHub" told a screen-reader user the wrong host — the same mislabelling the
   * refresh button had. The new tab is also the part `target="_blank"` leaves unannounced.
   */
  it("does not name a host it may not be going to", () => {
    for (const provider of ["github", "gitlab"] as const) {
      cleanup();
      render(<PullRequestBadge pr={pr({ provider })} />);
      const name = screen.getByRole("link").getAttribute("aria-label") ?? "";

      expect(name, provider).toContain("Opens in a new tab");
      expect(name, provider).not.toMatch(/Opens on/);
    }
  });

  /**
   * Shape, not hue: red against green on a badge this size is the pair colour blindness separates
   * worst, and the pulse is dropped under prefers-reduced-motion.
   *
   * All seven looks, not the four CI ones. The version of this test that ran the four passed while
   * `open` and `closed` were the same picture in the same grey — it iterated exactly the states
   * that did not collide, so it could not have caught it.
   */
  it("makes every state look different from every other", () => {
    const seen = ALL_LOOKS.map((of) => {
      cleanup();
      render(<PullRequestBadge pr={pr(of)} />);
      const badge = screen.getByTestId("pr-badge");
      // `data-look` is deliberately NOT in here. The first version of this compared it along with
      // the rest, and `data-look` differs by construction — so the assertion could not fail however
      // identical the badges looked, which is the bug it was written to catch wearing a disguise.
      return JSON.stringify({
        // The mark, the outline and the accent — the three things a glance has
        text: badge.textContent,
        icon: badge.querySelector("path")?.getAttribute("d")?.slice(0, 40),
        accent: badge.getAttribute("style"),
      });
    });

    expect(new Set(seen).size, seen.join("\n")).toBe(ALL_LOOKS.length);
  });

  it("keeps the running state visible when motion is unwelcome", () => {
    render(<PullRequestBadge pr={pr({ ci: "running" })} />);
    const pulsing = screen.getByTestId("pr-badge").querySelector(".animate-pulse");

    expect(pulsing?.className).toContain("motion-reduce:animate-none");
  });
});

describe("what each place has room to say", () => {
  // The card is narrow and the number is all it carries
  it("wears the number on the board", () => {
    render(<PullRequestState pr={pr({ ci: "failure", ciLabel: "e2e" })} />);

    expect(screen.getByTestId("pr-state").textContent).toContain("#12");
  });

  /**
   * The detail's row prints "#12 Keep the header visible" beside the chip, so a chip repeating the
   * number leaves the state unsaid — which is what that row said before this ticket touched it.
   */
  it("wears the state on the task detail, where the number is already printed", () => {
    render(<PullRequestState pr={pr({ ci: "failure", ciLabel: "e2e" })} says="status" />);
    const chip = screen.getByTestId("pr-state");

    expect(chip.textContent).toContain("e2e failed");
    expect(chip.querySelector("span:not(.sr-only)")?.textContent).not.toContain("#12");
  });

  it("says merged and open in plain words, as the row did before", () => {
    expect(pullRequestStatusText(pr({ state: "merged" }))).toBe("merged");
    expect(pullRequestStatusText(pr({ state: "open" }))).toBe("open");
    expect(pullRequestStatusText(pr({ state: "closed" }))).toContain("closed");
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

  /**
   * The row already prints "#12 Keep the header visible". A chip repeating the whole summary makes
   * a screen reader read the title a second time, which is why only the number form carries one.
   */
  it("does not make a screen reader read the title twice", () => {
    render(<PullRequestState pr={pr({ ci: "failure", ciLabel: "e2e" })} says="status" />);

    expect(screen.getByTestId("pr-state").querySelector(".sr-only")).toBeNull();
    expect(screen.getByText("e2e failed")).toBeTruthy();
  });
});
