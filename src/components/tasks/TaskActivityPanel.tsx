"use client";

import { useState } from "react";
import { Comments } from "./Comments";
import { ActivityTimeline } from "./ActivityTimeline";

interface TaskActivityPanelProps {
  projectId: string;
  taskId: string;
}

type Tab = "comments" | "history";

export function TaskActivityPanel({ projectId, taskId }: TaskActivityPanelProps) {
  const [tab, setTab] = useState<Tab>("comments");
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  const tabs: { id: Tab; label: string; count: number | null }[] = [
    { id: "comments", label: "Comments", count: commentCount },
    { id: "history", label: "History", count: historyCount },
  ];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Task discussion and history"
        className="flex gap-1 border-b border-border mb-4 overflow-x-auto"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`task-panel-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`task-panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`shrink-0 -mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === t.id
                ? "border-primary font-semibold text-text"
                : "border-transparent text-text-muted hover:text-text"
            }`}
          >
            {t.label}
            {t.count !== null && (
              <span className="ml-1.5 text-xs text-text-muted">{t.count}</span>
            )}
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
