// Copyright (c) 2026 Rafał Podleś. Licensed under the Board Planner Enterprise Edition Licence, see src/ee/LICENSE.
"use client";

import { useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useEntitlement } from "@/hooks/use-entitlement";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { MarkdownContent } from "@/components/ui/MarkdownContent";
import { ProUpsell } from "@/components/ui/ProUpsell";
import type { ApiSprint } from "@/types";

interface Notes {
  markdown: string;
  empty: boolean;
  tasks: number;
  pullRequests: number;
  tasksLeftOut: number;
  pullRequestsIncomplete: boolean;
  repositoryUnread: boolean;
}

const DATES = "\u0000dates";
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export function ReleaseNotesModal({
  projectId,
  sprints,
  initialSprintId,
  onClose,
}: {
  projectId: string;
  sprints: ApiSprint[];
  initialSprintId: string | null;
  onClose: () => void;
}) {
  const api = useApi();
  const entitlement = useEntitlement("ai.release_notes");
  const [covering, setCovering] = useState(initialSprintId ?? sprints[0]?._id ?? DATES);
  const [from, setFrom] = useState(daysAgo(14));
  const [to, setTo] = useState(today());
  const [tone, setTone] = useState<"changelog" | "customer">("changelog");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<Notes | null>(null);
  const [copied, setCopied] = useState(false);
  const asked = useRef(0);

  async function write() {
    const mine = ++asked.current;
    setBusy(true);
    setError("");
    setNotes(null);
    setCopied(false);
    try {
      const body = covering === DATES ? { from, to, tone } : { sprintId: covering, tone };
      const answer: Notes = await api.post(`/api/projects/${projectId}/release-notes`, body);
      if (mine === asked.current) setNotes(answer);
    } catch (e) {
      if (mine === asked.current) setError(e instanceof Error ? e.message : "The notes could not be written");
    } finally {
      if (mine === asked.current) setBusy(false);
    }
  }

  async function copy() {
    if (!notes) return;
    try {
      await navigator.clipboard.writeText(notes.markdown);
      setCopied(true);
    } catch {
      setError("The notes could not be copied; select the text instead.");
    }
  }

  return (
    <Modal open onClose={onClose} title="Release notes" size="lg" closeDisabled={busy}>
      {entitlement.loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : !entitlement.entitled ? (
        <ProUpsell title="Release notes">
          Notes written from the tasks finished in a sprint or between two days, and the pull requests merged with them.
        </ProUpsell>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Covering"
              value={covering}
              disabled={busy}
              onChange={(e) => setCovering(e.target.value)}
              options={[...sprints.map((s) => ({ value: s._id, label: s.name })), { value: DATES, label: "Between two days" }]}
            />
            <Select
              label="Written for"
              value={tone}
              disabled={busy}
              onChange={(e) => setTone(e.target.value as "changelog" | "customer")}
              options={[
                { value: "changelog", label: "Developers (changelog)" },
                { value: "customer", label: "Customers" },
              ]}
            />
          </div>
          {covering === DATES && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="From" type="date" value={from} max={to} disabled={busy} onChange={(e) => setFrom(e.target.value)} />
              <Input label="To" type="date" value={to} min={from} disabled={busy} onChange={(e) => setTo(e.target.value)} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={write} disabled={busy || (covering === DATES && (!from || !to))}>
              {busy ? "Writing…" : notes ? "Write again" : "Write the notes"}
            </Button>
            {notes && !notes.empty && (
              <Button size="sm" variant="secondary" onClick={copy}>
                {copied ? "Copied" : "Copy Markdown"}
              </Button>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {notes && (
            <div data-testid="release-notes" className="space-y-2">
              {!notes.empty && (
                <p className="text-sm text-text-muted">
                  From {notes.tasks} {notes.tasks === 1 ? "task" : "tasks"}
                  {notes.pullRequests > 0 && ` and ${notes.pullRequests} pull ${notes.pullRequests === 1 ? "request" : "requests"} with no task`}.
                </p>
              )}
              {notes.repositoryUnread && (
                <p className="text-sm text-warning">The repository could not be read, so pull requests with no task are missing.</p>
              )}
              {notes.tasksLeftOut > 0 && (
                <p className="text-sm text-warning">{notes.tasksLeftOut} more finished tasks did not fit; choose a shorter window.</p>
              )}
              {notes.pullRequestsIncomplete && (
                <p className="text-sm text-warning">The repository had more merges than could be read; some pull requests with no task are missing.</p>
              )}
              <div className="prose prose-sm max-w-none max-h-[50vh] overflow-y-auto rounded-lg border border-border p-3 text-sm leading-relaxed">
                <MarkdownContent>{notes.markdown}</MarkdownContent>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
