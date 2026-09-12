"use client";

import type { CSSProperties } from "react";
import type { ApiLinkedPR } from "@/types";

/**
 * One pull request, as a badge, in the three places that show one: the kanban card, the list row
 * and the task detail.
 *
 * Written once because it had already been written twice — the card and `LinkedWork` each carried
 * their own copy of the open/merged/closed colour mapping, and a third copy was what this ticket
 * would otherwise have added.
 */

export type PullRequestLook =
  | "open"
  | "running"
  | "success"
  | "failure"
  | "unknown"
  | "merged"
  | "closed";

/**
 * What the badge says, from the pull request's own state and what CI said about its head commit.
 *
 * The pull request's state wins: a merged branch's build is history, and a red check on work that
 * shipped a week ago is not news. CI only decides the look while the pull request is open.
 *
 * Defensive rather than live, and worth saying so: the sync never asks a finished pull request
 * about its checks, so today nothing writes a merged link carrying a CI state for this to outrank.
 * It is the right precedence the day something does, and it is pinned in the component test — the
 * end-to-end one cannot construct the state and does not claim to.
 */
export function pullRequestLook(pr: Pick<ApiLinkedPR, "state" | "ci">): PullRequestLook {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  // Absent on every link written before BP-443, and on every GitLab link: nothing has been read,
  // which is what `open` already means
  return pr.ci && pr.ci !== "none" ? pr.ci : "open";
}

/** Where the pull request has got to, in words: "open", "merged", "e2e failed". */
export function pullRequestStatusText(
  pr: Pick<ApiLinkedPR, "state" | "ci" | "ciLabel">
): string {
  const what = pr.ciLabel ?? "checks";
  const said: Record<PullRequestLook, string> = {
    merged: "merged",
    closed: "closed without merging",
    open: "open",
    running: `${what} running`,
    success: `${what} passed`,
    failure: `${what} failed`,
    // The one state GitHub never reports. "Not read" rather than "could not be read", because it
    // covers two causes: a request that failed, and a pull request past the sync's cap that nobody
    // asked about. Accusing the token of the second would send a reader to the wrong place.
    unknown: "checks not read",
  };
  return said[pullRequestLook(pr)];
}

/** The sentence the badge carries as its tooltip and as its accessible name. */
export function pullRequestSummary(
  pr: Pick<ApiLinkedPR, "number" | "title" | "state" | "ci" | "ciLabel">
): string {
  return `#${pr.number} ${pr.title} — ${pullRequestStatusText(pr)}`;
}

// Shape as well as colour, every time. Red against green on a badge this size is the pair that
// colour blindness separates worst, and the pulse below is dropped under reduced motion — so
// neither hue nor movement is ever the only thing carrying the state.
const GLYPH: Record<PullRequestLook, string> = {
  open: "",
  running: "●",
  success: "✓",
  failure: "✕",
  unknown: "?",
  // The merge icon is its own shape, so the chip needs no second mark
  merged: "",
  // Closed shares the pull-request icon with open, so without this the two are the same picture in
  // the same grey and a rejected branch reads as a live one. `origin/main` told them apart by
  // painting closed red; this keeps them apart by shape as well.
  //
  // A text glyph rather than a third icon path, knowingly: GitHub ships `git-pull-request-closed`
  // and it would be the better mark, but the merged icon this file inherited was four detached arcs
  // that rendered as a speck — a path written from memory is how that happened, and this is not the
  // ticket to do it again from memory twice. The cost is that ⊘ is font-dependent; looked at on
  // this platform at 11px in both themes, it renders as a circle and a slash, distinct from the
  // filled dot `running` wears.
  closed: "⊘",
};

const ACCENT: Record<PullRequestLook, string> = {
  open: "var(--color-text-muted)",
  running: "var(--color-warning)",
  success: "var(--color-success)",
  failure: "var(--color-danger)",
  unknown: "var(--color-text-muted)",
  merged: "#8b5cf6",
  // Quieter than open, not louder. The first attempt at "dark" used `var(--color-text)`, which
  // through `.chip-custom` degenerates to pure foreground — it made an abandoned pull request the
  // most prominent chip on the board, ahead of a failed build and a merge, for the one state that
  // means "nothing here". The step that separates it from open is the ⊘, which is shape rather
  // than volume; the accent recedes.
  closed: "color-mix(in srgb, var(--color-text-muted) 60%, var(--color-bg))",
};

// `git-merge-16`. What stood here was four detached arcs and a dot that rendered as an
// unrecognisable speck at 12px — invisible to every test, and obvious the moment the board was
// looked at. It came from TaskCard, which is why the card had it and the task detail did not.
const MERGED_PATH =
  "M5.45 5.154A4.25 4.25 0 009.25 7.5h1.378a2.251 2.251 0 110 1.5H9.25A5.734 5.734 0 015 7.123v3.505a2.25 2.25 0 11-1.5 0V5.372a2.25 2.25 0 111.95-.218ZM4.25 13.5a.75.75 0 100-1.5.75.75 0 000 1.5Zm8.5-4.5a.75.75 0 100-1.5.75.75 0 000 1.5ZM5 3.25a.75.75 0 100 .005V3.25Z";
const PR_PATH =
  "M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z";

const CHIP = `chip chip-custom inline-flex items-center gap-1 rounded px-1.5 py-0.5
  text-[11px] font-medium`;

function Face({ look, label }: { look: PullRequestLook; label: string }) {
  const glyph = GLYPH[look];
  return (
    <>
      <svg className="h-3 w-3 shrink-0" fill="currentColor" viewBox="0 0 16 16" aria-hidden>
        <path d={look === "merged" ? MERGED_PATH : PR_PATH} />
      </svg>
      {/* A check run's name is whatever the workflow calls it, and GitHub Actions names them things
          like "End to end — automation". On a phone the task detail's row is about 300px, so an
          uncapped one squeezes the title it sits beside down to nothing. */}
      <span className="truncate">{label}</span>
      {glyph && (
        <span
          aria-hidden
          className={look === "running" ? "animate-pulse motion-reduce:animate-none" : undefined}
        >
          {glyph}
        </span>
      )}
    </>
  );
}

/**
 * The badge as plain text, for the one place that is already inside a link — the task detail's
 * row. Nesting an anchor in an anchor is markup no two browsers agree on.
 */
export function PullRequestState({
  pr,
  says = "number",
  className = "",
}: {
  pr: ApiLinkedPR;
  /**
   * What the chip has room to say. The card is narrow and the number is the only thing on it, so
   * it wears `#41`; the task detail's row already prints the number and the title beside it, so
   * repeating them there would leave the state — the one thing that row did say before — unsaid.
   */
  says?: "number" | "status";
  className?: string;
}) {
  const look = pullRequestLook(pr);
  const summary = pullRequestSummary(pr);
  return (
    <span
      data-testid="pr-state"
      data-look={look}
      title={summary}
      className={`${CHIP} ${says === "status" ? "max-w-[45%]" : ""} ${className}`}
      style={{ "--chip": ACCENT[look] } as CSSProperties}
    >
      {/* On the number form the visible label is hidden from assistive technology and the sentence
          below replaces it. Left readable, the card's own `<a>` concatenates the two into
          "#41 #41 Keep the header visible — e2e failed": the summary already opens with the
          number. The status form needs neither — it says the state in words. */}
      <span aria-hidden={says === "number"} className="contents">
        <Face look={look} label={says === "status" ? pullRequestStatusText(pr) : `#${pr.number}`} />
      </span>
      {says === "number" && <span className="sr-only">{summary}</span>}
    </span>
  );
}

/** The badge as a link to the pull request, for the board and the list. */
export function PullRequestBadge({ pr, className = "" }: { pr: ApiLinkedPR; className?: string }) {
  const look = pullRequestLook(pr);
  const summary = pullRequestSummary(pr);

  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      // The card behind this is itself a click target and a drag handle. Without this, opening the
      // pull request also opens the task underneath it.
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      draggable={false}
      data-testid="pr-badge"
      data-look={look}
      // "a new tab" rather than "on GitHub": `ListView` renders every linked pull request through
      // this, GitLab's included, so naming the host told a screen-reader user the wrong one — the
      // same mislabelling the refresh button had. The new tab is also the part that is otherwise
      // unannounced, `target="_blank"` being invisible to assistive technology.
      //
      // `title` stays, and is deliberately a prefix of the name: a reader that announces the
      // description after the name hears the sentence twice, which is the price of the tooltip the
      // ticket asks for — and the list row has nowhere else to put it.
      title={summary}
      aria-label={`${summary}. Opens in a new tab`}
      className={`${CHIP} focus-ring transition-opacity hover:opacity-80 ${className}`}
      style={{ "--chip": ACCENT[look] } as CSSProperties}
    >
      <Face look={look} label={`#${pr.number}`} />
    </a>
  );
}
