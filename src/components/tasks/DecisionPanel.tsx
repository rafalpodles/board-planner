"use client";

import { useState } from "react";
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

/**
 * What accepting actually consents to, and the panel says it rather than implying otherwise.
 *
 * The first draft of this design claimed that for a Dockerfile or a package.json, accepting means
 * "push it so I can read it in a pull request", and that nothing executes until somebody merges.
 * That is false here: `.github/workflows/ci.yml` is `on: push` with no branch filter and runs
 * `npm ci` without `--ignore-scripts`, so the push alone is the trigger. The decision was to keep
 * the button and make the label honest.
 */
const ACCEPT_WARNING =
  "Accepting pushes this commit and opens a pull request. The push runs this repository's CI on the change — it does not merge it.";

const HEADLINE: Record<TaskDecisionState, string> = {
  pending: "A change is waiting for you",
  accepted: "Accepted — waiting for the machine to push it",
  declined: "Declined — waiting for the machine to remove it",
  abandoned: "Given up on",
  delivered: "Pushed, and a pull request is open",
  refused: "The machine would not push it",
  failed: "The push did not finish",
  discarded: "Declined, and the work was removed",
  superseded: "Superseded by a later run on this task",
};

/** The states a person still has something to say about. */
const ANSWERABLE: TaskDecisionState[] = ["pending", "refused", "failed"];
const LIVE: TaskDecisionState[] = ["pending", "accepted", "declined", "refused", "failed"];

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

export function DecisionPanel({ projectId, taskId, decision, onAnswered }: DecisionPanelProps) {
  const api = useApi();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (!decision) return null;

  const { state } = decision;
  const quietFor = decision.workerLastSeenAt
    ? Date.now() - Date.parse(decision.workerLastSeenAt)
    : Number.POSITIVE_INFINITY;
  // Only where it changes what a person should do: a machine that has not been heard from cannot
  // act on a verdict, and "abandon" is the way out of that.
  const waitingOnAMachine = state === "accepted" || state === "declined";
  const presumedGone = waitingOnAMachine && quietFor > PRESUMED_GONE_MS;

  async function answer(verdict: "accept" | "decline" | "abandon") {
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/tasks/${taskId}/decision`, { verdict });
      onAnswered();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not record that", "error");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section className="flex flex-col gap-3" data-testid="decision-panel">
      <SectionLabel>Refused change</SectionLabel>

      <div className="rounded-lg border border-border bg-bg-input p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium" data-testid="decision-headline">
            {HEADLINE[state]}
          </span>
          <span className="text-sm text-text-muted">
            · the <strong>{decision.gate}</strong> gate, at{" "}
            <code data-testid="decision-commit">{shortCommit(decision.commit)}</code>
          </span>
        </div>

        <p className="text-sm text-text-muted">
          The branch was not pushed, on purpose: what it carries is exactly what the gate refused.
          The work is in a worktree on{" "}
          <strong>{decision.workerName || decision.workerId}</strong>.
        </p>

        {presumedGone && (
          <p className="text-sm text-warning" data-testid="decision-machine-quiet">
            That machine has not been heard from since{" "}
            {new Date(decision.workerLastSeenAt!).toLocaleString()}. It may never see this. Giving
            up releases the task.
          </p>
        )}

        {decision.protectedFiles.length > 0 && (
          <div className="text-sm">
            <div className="text-text-muted">What tripped the gate:</div>
            <ul className="mt-1 flex flex-wrap gap-1.5" data-testid="decision-protected-files">
              {decision.protectedFiles.map((file) => (
                <li key={file} className="rounded bg-bg-hover px-1.5 py-0.5 font-mono text-xs">
                  {file}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Said plainly, because it is the sentence people get wrong: the gate's hits are a subset,
            and accepting pushes the commit, all of it. */}
        <div className="text-sm text-text-muted" data-testid="decision-file-count">
          Accepting pushes the whole commit — {decision.files.length}{" "}
          {decision.files.length === 1 ? "file" : "files"}.
        </div>

        {decision.patch && (
          <pre
            className="max-h-96 overflow-auto rounded border border-border bg-bg p-3 text-xs leading-relaxed"
            data-testid="decision-patch"
          >
            {decision.patch}
          </pre>
        )}

        {!decision.acceptable && (
          <p className="text-sm text-warning" data-testid="decision-unacceptable">
            This one cannot be accepted here: {decision.unacceptableReason}
          </p>
        )}

        {decision.error && (
          <p className="text-sm text-danger" data-testid="decision-error">
            {decision.error}
          </p>
        )}

        {decision.prUrl && (
          <a
            className="text-sm text-primary underline"
            href={decision.prUrl}
            target="_blank"
            rel="noreferrer"
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
            {ANSWERABLE.includes(state) && decision.acceptable && (
              <Button size="sm" onClick={() => setConfirming(true)} disabled={busy}>
                {state === "pending" ? "Accept and push" : "Try again"}
              </Button>
            )}
            {state === "pending" && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => answer("decline")}
                disabled={busy}
              >
                Decline and delete
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => answer("abandon")} disabled={busy}>
              Give up on it
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
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => answer("accept")}
        title="Accept this change?"
        message={ACCEPT_WARNING}
        confirmLabel="Accept and push"
        loadingLabel="Accepting..."
        loading={busy}
      />
    </section>
  );
}
