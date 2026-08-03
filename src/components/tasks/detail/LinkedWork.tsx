"use client";

import type { CSSProperties } from "react";
import { ApiTask } from "@/types";
import { TaskLinks } from "@/components/tasks/TaskLinks";
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
              className="flex items-center gap-3 rounded-lg border border-border bg-bg-input/40 px-3 py-2.5
                text-sm transition-colors hover:bg-bg-hover"
            >
              <svg
                className={`h-4 w-4 shrink-0 ${
                  pr.state === "merged"
                    ? "text-[#8b5cf6]"
                    : pr.state === "open"
                      ? "text-success"
                      : "text-danger"
                }`}
                fill="currentColor"
                viewBox="0 0 16 16"
                aria-hidden
              >
                <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
              </svg>
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
              <span
                className="chip chip-custom shrink-0 rounded px-2 py-0.5 text-[11px] font-medium"
                style={
                  {
                    "--chip":
                      pr.state === "merged"
                        ? "#8b5cf6"
                        : pr.state === "open"
                          ? "var(--color-success)"
                          : "var(--color-danger)",
                  } as CSSProperties
                }
              >
                {pr.state}
              </span>
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
