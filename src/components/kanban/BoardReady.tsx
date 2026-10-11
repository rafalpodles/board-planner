"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { EXECUTION_DOCS_URL } from "@/lib/docs-urls";
import { projectPath } from "@/lib/urls";
import type { ApiBoardReady, ApiBoardReadyStep, BoardReadyStepId } from "@/types";

const LABELS: Record<BoardReadyStepId, string> = {
  board: "Create the board",
  tasks: "Add your first tasks",
  team: "Invite your team",
  repository: "Point it at a repository",
  runs: "Allow agent runs",
  machine: "Connect a machine",
};

function whereToDo(step: ApiBoardReadyStep, projectRef: string): { label: string; href: string; external?: boolean } | null {
  const settings = (section: string) => `${projectPath(projectRef)}/settings?section=${section}`;
  switch (step.id) {
    case "team":
      return { label: "Settings › General", href: settings("general") };
    case "repository":
      return { label: "Settings › Integrations", href: settings("integrations") };
    case "runs":
      return step.locked ? null : { label: "Settings › Workers", href: settings("workers") };
    case "machine":
      return { label: "How to connect one", href: `${EXECUTION_DOCS_URL}#setting-one-up`, external: true };
    default:
      return null;
  }
}

function Row({ step, projectRef }: { step: ApiBoardReadyStep; projectRef: string }) {
  const where = step.done ? null : whereToDo(step, projectRef);
  return (
    <li
      data-testid="board-ready-step"
      data-step={step.id}
      data-done={step.done}
      className="flex items-start gap-2.5 border-t border-border py-2 first:border-t-0"
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] ${
          step.done ? "bg-success/15 text-success" : "border border-border"
        }`}
      >
        {step.done ? "✓" : ""}
      </span>
      <div className="min-w-0 text-sm">
        <span className={step.done ? "text-text-muted line-through" : "text-text"}>{LABELS[step.id]}</span>
        <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
        {step.locked && !step.done && (
          <p className="text-xs text-text-muted">An instance admin has locked agent runs off for this board.</p>
        )}
        {where && (
          <p className="text-xs text-text-muted">
            {where.external ? (
              <a href={where.href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                {where.label}
              </a>
            ) : (
              <Link href={where.href} className="text-primary hover:underline">
                {where.label}
              </Link>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

export function BoardReady({ projectId, projectRef }: { projectId: string; projectRef: string }) {
  const api = useApi();
  const [ready, setReady] = useState<ApiBoardReady | null>(null);
  const reads = useRef({ issued: 0, hiddenAfter: 0 });

  const load = useCallback(() => {
    const read = ++reads.current.issued;
    api
      .get(`/api/projects/${projectId}/ready`)
      .then((body: ApiBoardReady) => {
        // A read begun before Hide may answer after it with the list still shown
        if (read > reads.current.hiddenAfter) setReady(body);
      })
      .catch(() => {
        if (read > reads.current.hiddenAfter) setReady(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const hide = async () => {
    reads.current.hiddenAfter = reads.current.issued;
    setReady(null);
    try {
      await api.put(`/api/projects/${projectId}/ready`, { body: {} });
    } catch {
      load();
    }
  };

  if (!ready?.show) return null;
  const done = ready.steps.filter((s) => s.done).length;
  const group = (g: ApiBoardReadyStep["group"]) => ready.steps.filter((s) => s.group === g);

  return (
    <section
      data-testid="board-ready"
      aria-label="Get this board ready"
      className="mx-4 mb-3 mt-2 rounded-xl border border-border bg-bg-card p-4 lg:mx-6"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-text">Get this board ready</h2>
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span data-testid="board-ready-count">
            {done} of {ready.steps.length}
          </span>
          <button
            type="button"
            onClick={hide}
            data-testid="board-ready-hide"
            className="focus-ring rounded px-1 text-primary hover:underline"
          >
            Hide
          </button>
        </div>
      </div>
      <div className="my-2 h-1 overflow-hidden rounded bg-border" aria-hidden="true">
        <div className="h-full bg-success" style={{ width: `${Math.round((done / ready.steps.length) * 100)}%` }} />
      </div>
      <div className="lg:grid lg:grid-cols-2 lg:gap-x-8">
        <ul>
          {group("setup").map((s) => (
            <Row key={s.id} step={s} projectRef={projectRef} />
          ))}
        </ul>
        <div>
          <p className="mt-2 text-xs text-text-muted lg:mt-0 lg:border-b lg:border-border lg:py-2">Agents (optional)</p>
          <ul>
            {group("agents").map((s) => (
              <Row key={s.id} step={s} projectRef={projectRef} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
