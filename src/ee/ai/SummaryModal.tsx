// Copyright (c) 2026 Rafał Podleś. Licensed under the Board Planner Enterprise Edition Licence, see src/ee/LICENSE.
"use client";

import { useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useEntitlement } from "@/hooks/use-entitlement";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { MarkdownContent } from "@/components/ui/MarkdownContent";
import { ProUpsell } from "@/components/ui/ProUpsell";
import type { ApiSprint } from "@/types";

type Kind = "standup" | "sprint" | "project";

interface Summary {
  markdown: string;
  noteDropped: boolean;
  channels: number;
  sealed: string | null;
}

const KIND_LABELS: Record<Kind, string> = { standup: "Standup: the last day", sprint: "Sprint status", project: "Project status: the last week" };

export function SummaryModal({
  projectId,
  sprints,
  initialKind,
  initialSprintId,
  onClose,
}: {
  projectId: string;
  sprints: ApiSprint[];
  initialKind: Kind;
  initialSprintId: string | null;
  onClose: () => void;
}) {
  const api = useApi();
  const entitlement = useEntitlement("ai.digest");
  const [kind, setKind] = useState<Kind>(initialKind);
  const [sprintId, setSprintId] = useState(initialSprintId ?? sprints.find((s) => s.status === "active")?._id ?? sprints[0]?._id ?? "");
  const [busy, setBusy] = useState<"writing" | "posting" | null>(null);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [notice, setNotice] = useState("");
  const [posted, setPosted] = useState(false);
  const asked = useRef(0);

  function forget() {
    asked.current++;
    setSummary(null);
    setNotice("");
    setError("");
    setPosted(false);
  }

  const kinds = (Object.keys(KIND_LABELS) as Kind[]).filter((k) => k !== "sprint" || sprints.length > 0);

  async function write() {
    const mine = ++asked.current;
    setBusy("writing");
    setError("");
    setNotice("");
    setSummary(null);
    setPosted(false);
    try {
      const answer: Summary = await api.post(`/api/projects/${projectId}/summaries`, kind === "sprint" ? { kind, sprintId } : { kind });
      if (mine === asked.current) setSummary(answer);
    } catch (e) {
      if (mine === asked.current) setError(e instanceof Error ? e.message : "The summary could not be written");
    } finally {
      if (mine === asked.current) setBusy(null);
    }
  }

  async function post() {
    if (!summary?.sealed) return;
    setBusy("posting");
    setError("");
    try {
      const answer: { channels: number; delivered: number } = await api.post(`/api/projects/${projectId}/summaries/post`, { sealed: summary.sealed });
      setPosted(answer.delivered > 0);
      setNotice(
        answer.delivered === answer.channels
          ? `Posted to ${answer.channels === 1 ? "the team channel" : `${answer.channels} team channels`}.`
          : `Posted to ${answer.delivered} of ${answer.channels} team channels; the others did not accept it.`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "The summary could not be posted");
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(summary.markdown);
      setNotice("Copied.");
    } catch {
      setError("The summary could not be copied; select the text instead.");
    }
  }

  return (
    <Modal open onClose={onClose} title="Summary" size="lg" closeDisabled={busy !== null}>
      {entitlement.loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : !entitlement.entitled ? (
        <ProUpsell title="AI summaries">
          A standup, a sprint&apos;s status or the project&apos;s week, written around the figures the board counts itself.
        </ProUpsell>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Summary of" value={kind} disabled={busy !== null} onChange={(e) => {
                setKind(e.target.value as Kind);
                forget();
              }} options={kinds.map((k) => ({ value: k, label: KIND_LABELS[k] }))} />
            {kind === "sprint" && (
              <Select label="Sprint" value={sprintId} disabled={busy !== null} onChange={(e) => {
                  setSprintId(e.target.value);
                  forget();
                }} options={sprints.map((s) => ({ value: s._id, label: s.name }))} />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={write} disabled={busy !== null || (kind === "sprint" && !sprintId)}>
              {busy === "writing" ? "Writing…" : summary ? "Write again" : "Write the summary"}
            </Button>
            {summary && (
              <Button size="sm" variant="secondary" onClick={copy} disabled={busy !== null}>
                Copy Markdown
              </Button>
            )}
            {summary?.sealed && (
              <Button size="sm" variant="secondary" onClick={post} disabled={busy !== null || posted}>
                {busy === "posting" ? "Posting…" : posted ? "Posted" : "Post to team channel"}
              </Button>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm text-text-muted">
              {notice}
            </p>
          )}
          {summary && (
            <div data-testid="summary" className="space-y-2">
              {summary.noteDropped && (
                <p className="text-sm text-warning">The written note was left out because it gave figures of its own; these are the board&apos;s.</p>
              )}
              <div className="prose prose-sm max-w-none max-h-[50vh] overflow-y-auto rounded-lg border border-border p-3 text-sm leading-relaxed">
                <MarkdownContent>{summary.markdown}</MarkdownContent>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
