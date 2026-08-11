"use client";

import { useRef, useState, KeyboardEvent } from "react";
import { Comments } from "./Comments";
import { ActivityTimeline } from "./ActivityTimeline";
import type { ReferenceScope } from "@/lib/task-references";

interface TaskActivityPanelProps {
  projectId: string;
  scope?: ReferenceScope | null;
  taskId: string;
  /** Bumped when a comment is posted from the phone's bottom bar */
  commentRefreshKey?: number;
}

type Tab = "comments" | "history";

export function TaskActivityPanel({
  projectId,
  scope,
  taskId,
  commentRefreshKey = 0,
}: TaskActivityPanelProps) {
  const [tab, setTab] = useState<Tab>("comments");
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    comments: null,
    history: null,
  });

  const tabs: { id: Tab; label: string; count: number | null }[] = [
    { id: "comments", label: "Comments", count: commentCount },
    { id: "history", label: "History", count: historyCount },
  ];

  // role="tablist" promises arrow-key navigation to assistive tech, so it has to work
  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const order = tabs.map((t) => t.id);
    const i = order.indexOf(tab);
    let next: Tab | null = null;
    if (e.key === "ArrowRight") next = order[(i + 1) % order.length];
    else if (e.key === "ArrowLeft") next = order[(i - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Task discussion and history"
        className="mb-4 flex gap-1 overflow-x-auto"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`task-panel-tab-${t.id}`}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            aria-selected={tab === t.id}
            aria-controls={`task-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onKeyDown={handleKeyDown}
            onClick={() => setTab(t.id)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
              tab === t.id
                ? "bg-bg-input text-text"
                : "text-text-muted hover:text-text"
            }`}
          >
            {t.label}
            {t.count !== null && <span className="ml-1.5 opacity-60">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* Both stay mounted: switching tabs must not refetch, lose a half-typed
          comment, or reset the expanded history */}
      <div
        role="tabpanel"
        id="task-panel-comments"
        aria-labelledby="task-panel-tab-comments"
        hidden={tab !== "comments"}
      >
        <Comments
          projectId={projectId}
          taskId={taskId}
          scope={scope}
          refreshKey={commentRefreshKey}
          hideHeading
          onCountChange={setCommentCount}
          onMutated={() => setHistoryRefresh((k) => k + 1)}
        />
      </div>

      <div
        role="tabpanel"
        id="task-panel-history"
        aria-labelledby="task-panel-tab-history"
        hidden={tab !== "history"}
      >
        <ActivityTimeline
          projectId={projectId}
          taskId={taskId}
          hideHeading
          onCountChange={setHistoryCount}
          refreshKey={historyRefresh}
        />
      </div>
    </div>
  );
}
