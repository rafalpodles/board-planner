"use client";

import { useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SectionLabel } from "@/components/tasks/detail/atoms";
import { ApiTaskDecision, TaskDecisionState } from "@/types";

interface DecisionPanelProps {
  projectId: string;
  taskId: string;
  decision?: ApiTaskDecision;
  onAnswered: () => void;
}

/** What the panel calls a machine the fleet no longer names. */
const FALLBACK_MACHINE = "that machine";

/** A machine quiet for longer than this has probably not heard, and may never. */
const PRESUMED_GONE_MS = 10 * 60_000;

/** How often the machine is asked what became of the verdict. */
const WAITING_POLL_MS = 10_000;

/**
 * And how often once it has gone quiet. Backed off rather than stopped: the poll is the only thing
 * that refreshes the record, so stopping freezes `workerLastSeenAt` too and the panel can never
 * learn that the machine came back — leaving "waiting for the machine to push it" over a pull
 * request that is already open. Ten minutes of silence is also not death: this repository's own
 * rule is that staleness is not judged by silence, and the execution lease is two hours.
 */
const QUIET_POLL_MS = 60_000;

/**
 * What accepting actually consents to, and the panel says it rather than implying otherwise.
 *
 * The first draft of this design claimed that for a Dockerfile or a package.json, accepting means
 * "push it so I can read it in a pull request", and that nothing executes until somebody merges.
 * That is false here: `.github/workflows/ci.yml` is `on: push` with no branch filter and runs
 * `npm ci` without `--ignore-scripts`, so the push alone is the trigger. The decision was to keep
 * the button and make the label honest — including whose name it spends.
 */
function acceptWarning(machine: string): string {
  /*
   * Three short sentences rather than one long one, and "whichever account … pushes as" rather
   * than a name.
   *
   * Two earlier drafts of this sentence were false. "Your own GitHub identity" is wrong because
   * the push happens on the machine, under the token `githubIdentityToken()` resolves there — and
   * an instance admin may be answering for a machine that is not theirs. "Its owner's account" is
   * wrong too: that function returns the account pinned in the machine's own `github.json`, and a
   * machine with nothing pinned falls through to whichever account `gh` has active. The board's
   * record of who owns the machine does not decide it.
   */
  return [
    "Accepting pushes this commit and opens a pull request.",
    `The push goes out as whichever GitHub account ${machine} pushes as — not necessarily yours.`,
    "It runs this repository's CI on the change, and does not merge it.",
  ].join(" ");
}

/**
 * Giving up is not the quiet option it reads as. `sweepMarkers` treats a decision that has left the
 * live list exactly as it treats a declined one: the worktree goes. So the button says so and asks,
 * the way the board's forced move does — the difference between this and Decline is who is expected
 * to come back, not what happens to the work.
 *
 * Three sentences rather than one, because giving up means three different things. On `pending` the
 * answer was never given. On `accepted` it was, and the machine may be pushing right now — a person
 * who got impatient is racing a push that may already have succeeded, and one message saying "stops
 * waiting for an answer" would be simply false there.
 */
function abandonWarning(state: TaskDecisionState, machine: string): string {
  /*
   * What giving up actually does is settle the record, so the task stops waiting. The DELETION is
   * the machine's: `sweepMarkers` removes the worktree on the poll that finds the decision no
   * longer live. Which means the promise "the worktree is deleted" is least true in the case this
   * button is named for — a machine that is not coming back never polls, and its checkout stays
   * where it is.
   */
  // The fallback, capitalised for the one position that starts a sentence — and ONLY the fallback.
  // Transforming whatever `workerName` holds was the first shape of this fix and it mangled the
  // real thing instead: a machine called `e2e-macbook-pro` came out as `E2e-macbook-pro`.
  const sentenceStart = machine === FALLBACK_MACHINE ? "That machine" : machine;
  const after = `The task stops waiting. ${sentenceStart} removes the worktree on its next poll, so if it is really gone the worktree stays on that machine until somebody removes it.`;
  if (state === "accepted") {
    return `This change was accepted and ${machine} may be pushing it right now. Giving up does not undo a push that has already landed — check for a pull request before you do. ${after}`;
  }
  if (state === "declined") {
    return `This change was declined and ${machine} is removing it. Giving up stops waiting for it to confirm. ${after}`;
  }
  return `Nobody has answered this change, and giving up is not an answer — it withdraws the question. ${after}`;
}

const HEADLINE: Record<TaskDecisionState, string> = {
  pending: "A change is waiting for you",
  accepted: "Accepted — waiting for the machine to push it",
  declined: "Declined — waiting for the machine to remove it",
  abandoned: "Given up on",
  delivered: "Pushed, and a pull request is open",
  refused: "The machine could not push it",
  failed: "The push did not finish",
  discarded: "Declined, and the work was removed",
  superseded: "Superseded by a later run on this task",
};

/** The states a person still has something to say about. */
const ANSWERABLE: TaskDecisionState[] = ["pending", "refused", "failed"];
const LIVE: TaskDecisionState[] = ["pending", "accepted", "declined", "refused", "failed"];
/** Waiting on the machine rather than on a person. */
const WITH_THE_MACHINE: TaskDecisionState[] = ["accepted", "declined"];

/** What the person whose name sits at the foot of the panel actually did. */
const ANSWERED_BY: Record<TaskDecisionState, string> = {
  pending: "Last answered by",
  accepted: "Accepted by",
  delivered: "Accepted by",
  refused: "Accepted by",
  failed: "Accepted by",
  declined: "Declined by",
  discarded: "Declined by",
  abandoned: "Given up by",
  superseded: "Last answered by",
};

/**
 * Where a link goes, for a reader to judge — and "" for a url this cannot read.
 *
 * The panel drops the link rather than labelling it unverifiable: the whole reason the host is in
 * the visible text is that the url is worker-supplied, and an anchor reading "an unknown host" is
 * the one shape that asks somebody to click without telling them where.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

type Asking = "accept" | "abandon" | null;

export function DecisionPanel({ projectId, taskId, decision, onAnswered }: DecisionPanelProps) {
  const api = useApi();
  const { toast } = useToast();
  const [busy, setBusy] = useState<"accept" | "decline" | "abandon" | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  // Held in state rather than read at render time, so the ten-minute mark can arrive while
  // somebody is looking at the panel rather than only when they reload it.
  const [now, setNow] = useState(() => Date.now());
  const patchRef = useRef<HTMLPreElement>(null);
  const [patchScrolls, setPatchScrolls] = useState(false);

  const state = decision?.state;
  const lastSeen = decision?.workerLastSeenAt;
  // One clock for both, read from state: `Date.now()` here and `now` below would agree only by
  // the accident of the tick that happens to precede this render.
  const quietFor = lastSeen ? now - Date.parse(lastSeen) : Number.POSITIVE_INFINITY;
  const quiet = quietFor > PRESUMED_GONE_MS;
  /** Whether anybody else is still expected to act. */
  const waiting = state !== undefined && WITH_THE_MACHINE.includes(state);
  const isLive = state !== undefined && LIVE.includes(state);

  /**
   * The task screen does not poll, so without this the panel stays on "waiting for the machine to
   * push it" for ever: the pull request, the refusal and the error all arrive on a reload nobody
   * knows to do. Bounded to the two states where somebody else is acting.
   */
  /**
   * The clock, on its own, for every live state.
   *
   * `presumedGone` covers all of `LIVE`, but only `accepted`/`declined` poll — so on `pending`,
   * `refused` and `failed` the warning was frozen at whatever it said when the panel mounted: a
   * machine going quiet while somebody read the diff was never announced, and one that came back
   * never cleared. `pending` is the state that most needs it, since whether the machine is coming
   * back is the whole of what separates Decline from Give up.
   */
  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => setNow(Date.now()), QUIET_POLL_MS);
    return () => clearInterval(timer);
  }, [isLive]);

  useEffect(() => {
    if (!waiting) return;
    let live = true;
    const timer = setInterval(() => {
      setNow(Date.now());
      // The narrow read, not the whole task: the task-detail route selects the patch, which is up
      // to 220 KB and never changes. A full reload happens only once the answer actually moves.
      void api
        .get(`/api/projects/${projectId}/tasks/${taskId}/decision`)
        .then((body: { decision?: { state?: string; workerLastSeenAt?: string | null } | null }) => {
          if (!live || !body?.decision?.state) return;
          // Liveness as well as the state. The read already carries `workerLastSeenAt`, and
          // without this the panel goes on saying "may never see this" over a machine that came
          // back and is mid-push, because the state has not moved yet.
          // Only out of quiet. `touchWorker` moves `lastSeenAt` on every heartbeat, which is
          // every thirty seconds by default — so comparing the value alone reloaded three
          // endpoints twice a minute over a machine that was never anything but healthy. While
          // the machine is not quiet a fresher timestamp changes nothing on screen: `presumedGone`
          // is its only reader.
          const seen = body.decision.workerLastSeenAt;
          const cameBack = quiet && Boolean(seen) && seen !== lastSeen;
          if (body.decision.state !== state || cameBack) onAnswered();
        })
        .catch(() => {
          // A poll that cannot reach the server says nothing; the next one tries again.
        });
    }, quiet ? QUIET_POLL_MS : WAITING_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [waiting, quiet, onAnswered, api, projectId, taskId, state, lastSeen]);

  // A scroll region is only a reading surface if a keyboard can reach it, and only worth a tab
  // stop when there is something to scroll to.
  useEffect(() => {
    const element = patchRef.current;
    if (!element) return;
    const measure = () => setPatchScrolls(element.scrollHeight > element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [decision?.patch]);

  if (!decision || !state) return null;

  /**
   * Across every live state, not only the two the machine is acting in.
   *
   * The first round of review had this the other way round — noise on a record waiting for a
   * person. It is the opposite: on `pending` the panel offers Decline and Give up side by side,
   * both saying "delete", and the only thing separating them is whether that machine is coming
   * back. Withholding the one fact that answers that made the advice unactionable exactly where
   * the choice is made.
   */
  const presumedGone = LIVE.includes(state) && quiet;
  const canAccept = ANSWERABLE.includes(state) && decision.acceptable;

  async function answer(verdict: "accept" | "decline" | "abandon") {
    setBusy(verdict);
    try {
      await api.post(`/api/projects/${projectId}/tasks/${taskId}/decision`, { verdict });
      onAnswered();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not record that", "error");
      // Reloaded on the way out too. The verdict is pinned to the record this screen read, so a
      // refusal means what is on screen is not what is there any more — the patch, the file list
      // and the buttons all belong to a decision that has been answered or replaced. Leaving them
      // up gives somebody a live Accept button over a change that no longer exists.
      onAnswered();
    } finally {
      setBusy(null);
      setAsking(null);
    }
  }

  return (
    <section className="flex flex-col gap-3" data-testid="decision-panel">
      <SectionLabel>Refused change</SectionLabel>

      {/* bg-bg-card, not bg-bg-input: the two chips below use bg-bg-hover, which is the SAME colour
          as bg-bg-input in both themes, and text-danger falls to 3.74:1 on it. */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-card p-4">
        {/* One live region across every state, so a verdict's outcome is announced rather than
            silently replacing the headline — the shape the autosave status already uses. */}
        <div role="status" aria-live="polite" className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-medium" data-testid="decision-headline">
              {HEADLINE[state]}
            </span>
            <span className="text-sm text-text-muted">
              · the <strong>{decision.gate}</strong> gate, at{" "}
              <code data-testid="decision-commit">{decision.commit.slice(0, 12)}</code>
            </span>
          </div>

          {decision.error && (
            <p className="text-sm text-danger" data-testid="decision-error">
              The machine reported: {decision.error}
            </p>
          )}

          {/* Accept and abandon announce themselves through ConfirmDialog's own loading label;
              decline has no dialog, so its only feedback was a word on a button that had just
              left the tab order. */}
          {busy === "decline" && <span className="sr-only">Declining...</span>}
        </div>

        {/* Only while it is true. Once the record is settled the headline says what happened, and
            this paragraph would contradict it — "the branch was not pushed" under "Pushed". */}
        {state === "pending" && (
          <p className="text-sm text-text-muted" data-testid="decision-where-the-work-is">
            The branch was not pushed, on purpose: what it carries is exactly what the gate refused.
            The work is in a worktree on <strong>{decision.workerName || decision.workerId}</strong>.
          </p>
        )}

        {presumedGone && (
          <p className="text-sm text-warning" data-testid="decision-machine-quiet">
            {decision.workerName || "That machine"} has not been heard from since{" "}
            {new Date(decision.workerLastSeenAt!).toLocaleString()}. It may never see this.
          </p>
        )}

        {decision.protectedFiles.length > 0 && (
          <div className="text-sm">
            <div className="text-text-muted" id="decision-protected-label">
              What tripped the gate:
            </div>
            <ul
              className="mt-1 flex flex-wrap gap-1.5"
              aria-labelledby="decision-protected-label"
              data-testid="decision-protected-files"
            >
              {decision.protectedFiles.map((file) => (
                <li key={file} className="rounded bg-bg-hover px-1.5 py-0.5 font-mono text-xs">
                  {file}
                </li>
              ))}
              {/* The list is bounded; the count is not. Silently showing five hundred of seven
                  hundred would make "what tripped the gate" smaller than what did. */}
              {decision.protectedFileCount > decision.protectedFiles.length && (
                <li className="px-1.5 py-0.5 text-xs text-text-muted">
                  and {decision.protectedFileCount - decision.protectedFiles.length} more
                </li>
              )}
            </ul>
          </div>
        )}

        {/* The sentence people get wrong — the gate's hits are a subset — but only where accepting
            is on offer, or it promises a button that is not there. */}
        {canAccept && (
          <div className="text-sm text-text-muted" data-testid="decision-file-count">
            {/* Named for the button that is actually on screen: in the retry states it says
                "Try again", and "Accepting pushes…" points at a verb nothing offers. */}
            {state === "pending" ? "Accepting" : "Trying again"} pushes the whole commit —{" "}
            {decision.fileCount} {decision.fileCount === 1 ? "file" : "files"}.
          </div>
        )}

        {decision.patch && (
          <pre
            ref={patchRef}
            // Scrollable, so it has to be reachable: this is the feature's primary reading surface
            // and the app hides every scrollbar globally, which leaves a wheel the only way in.
            // Wrapped rather than scrolled sideways, for the same reason.
            tabIndex={patchScrolls ? 0 : undefined}
            role={patchScrolls ? "region" : undefined}
            // With the role: a name on a role-less element is ignored by some assistive technology
            // and suppresses the content in others.
            aria-label={patchScrolls ? "The refused change" : undefined}
            className="focus-ring max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg p-3 text-xs leading-relaxed"
            data-testid="decision-patch"
          >
            {decision.patch}
          </pre>
        )}

        {!decision.acceptable && ANSWERABLE.includes(state) && (
          <p className="text-sm text-warning" data-testid="decision-unacceptable">
            This one cannot be accepted here: {decision.unacceptableReason}
          </p>
        )}

        {decision.prUrl && hostOf(decision.prUrl) && (
          <a
            className="text-sm text-primary underline"
            href={decision.prUrl}
            title={decision.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="decision-pr"
          >
            {/* The host, visibly. The url is worker-supplied and its shape is checked but its
                host is not, and a clipped url in a tooltip is invisible on a touch screen and to
                a screen reader — which is where somebody would have noticed an odd one. */}
            Open the pull request on {hostOf(decision.prUrl)}
          </a>
        )}

        {decision.decidedBy && decision.decidedAt && (
          <div className="text-xs text-text-muted" data-testid="decision-decided-by">
            {/* With the verb. A bare name and date above the buttons reads as the assignee. */}
            {ANSWERED_BY[state]} {decision.decidedBy.fullName || decision.decidedBy.username} ·{" "}
            {new Date(decision.decidedAt).toLocaleString()}
          </div>
        )}

        {decision.canDecide && LIVE.includes(state) && (
          <div className="flex flex-wrap gap-2">
            {canAccept && (
              // danger, not primary: primary reads as recommended, and this is the one action on
              // the panel that executes the agent's change somewhere.
              <Button
                variant="danger"
                size="sm"
                onClick={() => setAsking("accept")}
                disabled={busy !== null}
              >
                {state === "pending" ? "Accept and push" : "Try again"}
              </Button>
            )}
            {state === "pending" && (
              // No confirm: the label already says what it does, and saying no to a change a gate
              // refused is the outcome this panel exists to make easy.
              <Button
                variant="secondary"
                size="sm"
                onClick={() => answer("decline")}
                disabled={busy !== null}
              >
                {busy === "decline" ? "Declining..." : "Decline"}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAsking("abandon")}
              disabled={busy !== null}
            >
              Give up
            </Button>
          </div>
        )}

        {!decision.canDecide && LIVE.includes(state) && (
          <p className="text-xs text-text-muted" data-testid="decision-not-yours">
            Only {decision.workerName || FALLBACK_MACHINE}&apos;s owner, or an instance admin, can
            answer this.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={asking === "accept"}
        onClose={() => setAsking(null)}
        onConfirm={() => answer("accept")}
        title="Accept this change?"
        message={acceptWarning(decision.workerName || FALLBACK_MACHINE)}
        confirmLabel="Accept and push"
        loadingLabel="Accepting..."
        loading={busy === "accept"}
      />

      <ConfirmDialog
        open={asking === "abandon"}
        onClose={() => setAsking(null)}
        onConfirm={() => answer("abandon")}
        title="Give up on this change?"
        message={abandonWarning(state, decision.workerName || FALLBACK_MACHINE)}
        confirmLabel="Give up on it"
        loadingLabel="Giving up..."
        loading={busy === "abandon"}
      />
    </section>
  );
}
