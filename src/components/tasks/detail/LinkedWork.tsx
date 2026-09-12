"use client";

import { useState, type CSSProperties } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { ApiTask } from "@/types";
import { TaskLinks } from "@/components/tasks/TaskLinks";
import { PullRequestState } from "@/components/tasks/PullRequestBadge";
import { SectionLabel } from "./atoms";

interface LinkedWorkProps {
  projectId: string;
  projectKey: string;
  task: ApiTask;
  columns: { id: string; label: string; color: string }[];
  onChanged: () => void;
  onAddChild: () => void;
}

export function LinkedWork({
  projectId,
  projectKey,
  task,
  columns,
  onChanged,
  onAddChild,
}: LinkedWorkProps) {
  const api = useApi();
  const { toast } = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const prs = task.linkedPRs || [];
  // GitLab has its own sync, in project settings. Without this the button appears on a GitLab-only
  // task and the GitHub endpoint answers "…is not a GitHub repository" every time — a correct
  // sentence under a wrong label.
  const refreshable = prs.some((pr) => (pr.provider ?? "github") === "github");

  /**
   * Asks GitHub again. One request answers for every open branch, so the links this brings back
   * are the project's — but `taskNumber` keeps the merged-to-ready_to_test move to this task, the
   * one the person is looking at. A button called "Refresh PR status" must not move somebody
   * else's task, least of all under the clicking user's name.
   */
  async function refresh() {
    setRefreshing(true);
    try {
      const result: { prsLinked?: number; autoTransitioned?: number } = await api.post(
        `/api/projects/${projectId}/github/sync`,
        { taskNumber: task.taskNumber }
      );
      onChanged();
      // Said rather than left to be inferred: without it a refresh that found nothing looks
      // exactly like a button that did nothing
      toast(
        result?.autoTransitioned
          ? "Pull requests refreshed — this task moved to Ready to Test"
          : "Pull requests refreshed",
        "success"
      );
    } catch (err) {
      // The message the route gave, which says which of the several refusals it was — an
      // unconfigured token and an unreachable GitHub send somebody to different places
      toast(err instanceof Error ? err.message : "Could not refresh the pull requests", "error");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>Linked work</SectionLabel>
        {refreshable && (
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-busy={refreshing}
            className="focus-ring rounded text-xs text-text-muted transition-colors
              hover:text-text disabled:opacity-60"
          >
            {refreshing ? "Refreshing…" : "Refresh PR status"}
          </button>
        )}
      </div>

      {prs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {prs.map((pr) => (
            <a
              key={`${pr.provider ?? "github"}-${pr.number}`}
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring flex items-center gap-3 rounded-lg border border-border bg-bg-input/40
                px-3 py-2.5 text-sm transition-colors hover:bg-bg-hover"
            >
              <span className="min-w-0 flex-1 truncate">
                #{pr.number} {pr.title}
              </span>
              {pr.provider === "gitlab" && (
                <span
                  className="chip chip-custom shrink-0 rounded px-2 py-0.5 text-[11px] font-medium"
                  style={{ "--chip": "#fc6d26" } as CSSProperties}
                >
                  GitLab
                </span>
              )}
              {/* The badge is a link of its own, which inside this one would be markup no browser
                  agrees on. It is the same look rendered as plain text, and the row is the link. */}
              <PullRequestState pr={pr} says="status" className="shrink-0" />
            </a>
          ))}
        </div>
      )}

      <TaskLinks
        projectId={projectId}
        projectKey={projectKey}
        task={task}
        columns={columns}
        onChanged={onChanged}
        actions={
          <button
            type="button"
            onClick={onAddChild}
            className="focus-ring rounded text-sm text-text-muted transition-colors hover:text-text"
          >
            + Add subtask
          </button>
        }
      />
    </section>
  );
}
