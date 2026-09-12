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

/** A machine quiet for longer than this has probably not heard, and may never. */
const PRESUMED_GONE_MS = 10 * 60_000;

/** How often the task is re-read while a verdict is with the machine. */
const WAITING_POLL_MS = 10_000;

/**
 * What accepting actually consents to, and the panel says it rather than implying otherwise.
 *
 * The first draft of this design claimed that for a Dockerfile or a package.json, accepting means
 * "push it so I can read it in a pull request", and that nothing executes until somebody merges.
 * That is false here: `.github/workflows/ci.yml` is `on: push` with no branch filter and runs
 * `npm ci` without `--ignore-scripts`, so the push alone is the trigger. The decision was to keep
 * the button and make the label honest — including whose name it spends.
 */
const ACCEPT_WARNING =
  "Accepting pushes this commit under your own GitHub identity and opens a pull request. The push runs this repository's CI on the change — it does not merge it.";

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
function abandonWarning(state: TaskDecisionState): string {
  const deletes =
    "The worktree holding this change is deleted, the same as declining. Use it when that machine is not coming back.";
  if (state === "accepted") {
    return `This change was accepted and the machine may be pushing it right now. Giving up stops waiting for the result — it does not undo a push that has already landed. ${deletes}`;
  }
  if (state === "declined") {
    return `This change was declined and the machine is removing it. Giving up stops waiting for it to confirm. ${deletes}`;
  }
  return `The machine stops waiting for an answer. ${deletes}`;
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
  /**
   * Whether anybody else is still expected to act. `loadData` fetches three endpoints, so a poll
   * that never stops is three requests every ten seconds per open tab, for ever — and a machine
   * that was re-imaged or switched off stays `accepted` for ever. The moment it becomes pointless
   * is the moment the panel already computes.
   */
  const waiting =
    state !== undefined &&
    WITH_THE_MACHINE.includes(state) &&
    (!lastSeen || Date.now() - Date.parse(lastSeen) <= PRESUMED_GONE_MS);

  /**
   * The task screen does not poll, so without this the panel stays on "waiting for the machine to
   * push it" for ever: the pull request, the refusal and the error all arrive on a reload nobody
   * knows to do. Bounded to the two states where somebody else is acting.
   */
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      onAnswered();
    }, WAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, onAnswered]);

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

  const quietFor = decision.workerLastSeenAt
    ? now - Date.parse(decision.workerLastSeenAt)
    : Number.POSITIVE_INFINITY;
  /**
   * Across every live state, not only the two the machine is acting in.
   *
   * The first round of review had this the other way round — noise on a record waiting for a
   * person. It is the opposite: on `pending` the panel offers Decline and Give up side by side,
   * both saying "delete", and the only thing separating them is whether that machine is coming
   * back. Withholding the one fact that answers that made the advice unactionable exactly where
   * the choice is made.
   */
  const presumedGone = LIVE.includes(state) && quietFor > PRESUMED_GONE_MS;
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
            </ul>
          </div>
        )}

        {/* The sentence people get wrong — the gate's hits are a subset — but only where accepting
            is on offer, or it promises a button that is not there. */}
        {canAccept && (
          <div className="text-sm text-text-muted" data-testid="decision-file-count">
            Accepting pushes the whole commit — {decision.files.length}{" "}
            {decision.files.length === 1 ? "file" : "files"}.
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

        {decision.prUrl && (
          <a
            className="truncate text-sm text-primary underline"
            href={decision.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="decision-pr"
          >
            {decision.prUrl}
          </a>
        )}

        {decision.decidedBy && decision.decidedAt && (
          <div className="text-xs text-text-muted" data-testid="decision-decided-by">
            {decision.decidedBy.fullName || decision.decidedBy.username} ·{" "}
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
                {busy === "decline" ? "Declining..." : "Decline and delete"}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAsking("abandon")}
              disabled={busy !== null}
            >
              Give up and delete the work
            </Button>
          </div>
        )}

        {!decision.canDecide && LIVE.includes(state) && (
          <p className="text-xs text-text-muted" data-testid="decision-not-yours">
            Only {decision.workerName || "that machine"}&apos;s owner, or an instance admin, can
            answer this.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={asking === "accept"}
        onClose={() => setAsking(null)}
        onConfirm={() => answer("accept")}
        title="Accept this change?"
        message={ACCEPT_WARNING}
        confirmLabel="Accept and push"
        loadingLabel="Accepting..."
        loading={busy === "accept"}
      />

      <ConfirmDialog
        open={asking === "abandon"}
        onClose={() => setAsking(null)}
        onConfirm={() => answer("abandon")}
        title="Give up on this change?"
        message={abandonWarning(state)}
        confirmLabel="Give up and delete"
        loadingLabel="Giving up..."
        loading={busy === "abandon"}
      />
    </section>
  );
}
