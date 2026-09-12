"use client";

import type { CSSProperties } from "react";
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
  const prs = task.linkedPRs || [];

  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>Linked work</SectionLabel>

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
              <PullRequestState pr={pr} className="shrink-0" />
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
