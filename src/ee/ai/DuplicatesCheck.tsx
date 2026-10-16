// Copyright (c) 2026 Rafał Podleś. Licensed under the Board Planner Enterprise Edition Licence, see src/ee/LICENSE.
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { useEntitlement } from "@/hooks/use-entitlement";
import { Button } from "@/components/ui/Button";
import { ProUpsell } from "@/components/ui/ProUpsell";

interface Duplicate {
  taskId: string;
  key: string;
  title: string;
  status: string;
  reason: string;
}

type Shown = { duplicates: Duplicate[] } | null;

/**
 * A draft's check offers a tick per candidate, linked once the task exists (`selected`); a task's
 * check links at once through the task's own links route, which keeps its cycle check.
 */
export function DuplicatesCheck({
  projectId,
  projectKey,
  title,
  description,
  taskId,
  linkedIds = [],
  selected,
  onSelect,
  onLinked,
}: {
  projectId: string;
  projectKey?: string;
  title: string;
  description: string;
  taskId?: string;
  linkedIds?: string[];
  selected?: string[];
  onSelect?: (ids: string[]) => void;
  onLinked?: () => void;
}) {
  const api = useApi();
  const entitlement = useEntitlement("ai.duplicates");
  const [shown, setShown] = useState<Shown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [upsell, setUpsell] = useState(false);
  const asked = useRef(0);

  // A result belongs to the text it was asked about; a draft that changes drops it
  useEffect(() => {
    if (taskId) return;
    asked.current++;
    setShown(null);
    onSelect?.([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, taskId]);

  async function check() {
    if (!entitlement.entitled) {
      setUpsell(true);
      return;
    }
    const mine = ++asked.current;
    setBusy("checking");
    setError("");
    try {
      const answer: { duplicates: Duplicate[] } = await api.post(`/api/projects/${projectId}/duplicates`, { title, description, ...(taskId && { taskId }) });
      if (mine === asked.current) setShown({ duplicates: answer.duplicates });
    } catch (e) {
      if (mine === asked.current) setError(e instanceof Error ? e.message : "The check did not work");
    } finally {
      if (mine === asked.current) setBusy(null);
    }
  }

  async function link(d: Duplicate) {
    setBusy(d.taskId);
    setError("");
    try {
      await api.post(`/api/projects/${projectId}/tasks/${taskId}/links`, { taskId: d.taskId, type: "duplicates" });
      onLinked?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The link was not added");
    } finally {
      setBusy(null);
    }
  }

  const ticked = new Set(selected ?? []);
  const taskHref = (d: Duplicate) => `/projects/${projectKey ?? projectId}/tasks/${d.key.split("-").pop()}`;

  return (
    <div className="flex flex-col gap-2" data-testid="duplicates-check">
      <div>
        <Button type="button" size="sm" variant="secondary" onClick={check} disabled={busy !== null || !title.trim() || entitlement.loading}>
          {busy === "checking" ? "Checking…" : taskId ? "Find duplicates" : "Check for duplicates"}
        </Button>
      </div>
      {upsell && (
        <ProUpsell title="Duplicate detection">The board&apos;s tasks that describe the same work in other words, with the reason for each.</ProUpsell>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {shown && shown.duplicates.length === 0 && <p className="text-sm text-text-muted">No likely duplicates on this board.</p>}
      {shown && shown.duplicates.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Possible duplicates">
          {shown.duplicates.map((d) => {
            const linked = linkedIds.includes(d.taskId);
            return (
              <li key={d.taskId} className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border border-border p-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <Link href={taskHref(d)} target={taskId ? undefined : "_blank"} className="focus-ring rounded font-medium text-primary underline">
                    {d.key} {d.title}
                  </Link>
                  {d.reason && <p className="text-text-muted">{d.reason}</p>}
                </div>
                {taskId ? (
                  <Button type="button" size="sm" variant="secondary" onClick={() => link(d)} disabled={busy !== null || linked} aria-label={`Mark as a duplicate of ${d.key}`}>
                    {linked ? "Marked" : "Mark as duplicate"}
                  </Button>
                ) : (
                  <label className="flex shrink-0 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={ticked.has(d.taskId)}
                      onChange={(e) => onSelect?.(e.target.checked ? [...ticked, d.taskId] : [...ticked].filter((id) => id !== d.taskId))}
                    />
                    Duplicate of {d.key}
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
