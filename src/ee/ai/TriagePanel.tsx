// Copyright (c) 2026 Rafał Podleś. Licensed under the Board Planner Enterprise Edition Licence, see src/ee/LICENSE.
"use client";

import { useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { Button } from "@/components/ui/Button";
import { SectionLabel } from "@/components/tasks/detail/atoms";
import type { ApiCustomField, ApiTaskTriage, ApiTriageSuggestion } from "@/types";

const POLL_MS = 3000;
const POLLS = 20;

function describe(s: ApiTriageSuggestion, fields: ApiCustomField[]): { name: string; value: string } {
  if (s.field === "assignee") return { name: "Assignee", value: s.value };
  if (s.field === "category") return { name: "Category", value: s.value };
  const field = fields.find((f) => f._id === s.fieldId);
  return { name: field?.name ?? "Field", value: field?.options.find((o) => o.id === s.value)?.value ?? s.value };
}

export function TriagePanel({
  projectId,
  taskId,
  triage: initial,
  customFields,
  onChanged,
}: {
  projectId: string;
  taskId: string;
  triage?: ApiTaskTriage;
  customFields: ApiCustomField[];
  onChanged: () => void;
}) {
  const api = useApi();
  const [triage, setTriage] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const changed = useRef(onChanged);
  changed.current = onChanged;

  useEffect(() => setTriage(initial), [initial]);

  const waiting = triage?.state === "pending" || triage?.state === "running";
  useEffect(() => {
    if (!waiting) return;
    let polls = 0;
    const timer = setInterval(async () => {
      if (++polls > POLLS) return clearInterval(timer);
      try {
        const answer: { triage: ApiTaskTriage | null } = await api.get(`/api/projects/${projectId}/tasks/${taskId}/triage`);
        if (answer.triage && answer.triage.state !== "pending" && answer.triage.state !== "running") {
          clearInterval(timer);
          setTriage(answer.triage);
          if (answer.triage.suggestions.some((s) => s.outcome === "applied")) changed.current();
        }
      } catch {
        clearInterval(timer);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, api, projectId, taskId]);

  if (!triage) return null;
  const shown = triage.suggestions.filter((s) => s.outcome === "open" || s.outcome === "applied");
  if (!waiting && shown.length === 0) return null;

  async function act(s: ApiTriageSuggestion, action: "apply" | "dismiss" | "undo") {
    setBusy(s._id);
    setError("");
    try {
      const answer: { triage: ApiTaskTriage } = await api.post(`/api/projects/${projectId}/tasks/${taskId}/triage`, { suggestionId: s._id, action });
      setTriage(answer.triage);
      if (action !== "dismiss") changed.current();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-2.5" data-testid="triage-panel">
      <SectionLabel>AI triage</SectionLabel>
      {waiting ? (
        <p className="text-sm text-text-muted">Reading the task…</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((s) => {
            const { name, value } = describe(s, customFields);
            return (
              <li key={s._id} className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border border-border p-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <p>
                    <span className="text-text-muted">{name}: </span>
                    <span className="font-medium">{value}</span>
                    {s.outcome === "applied" && <span className="text-text-muted"> · applied</span>}
                  </p>
                  {s.reason && <p className="text-text-muted">{s.reason}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  {s.outcome === "open" ? (
                    <>
                      <Button size="sm" onClick={() => act(s, "apply")} disabled={busy !== null} aria-label={`Apply ${name}: ${value}`}>
                        Apply
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => act(s, "dismiss")} disabled={busy !== null} aria-label={`Dismiss ${name}: ${value}`}>
                        Dismiss
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => act(s, "undo")} disabled={busy !== null} aria-label={`Undo ${name}: ${value}`}>
                      Undo
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
