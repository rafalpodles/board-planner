"use client";

import Link from "next/link";
import { Popover } from "@/components/ui/Popover";
import { projectPath } from "@/lib/urls";
import { CopyTaskLink } from "../CopyTaskLink";
import { StatusPill } from "./StatusPill";
import { OptionItem, OptionList } from "./FieldRow";

interface Column {
  id: string;
  label: string;
  color: string;
}

interface TaskTopBarProps {
  projectName: string;
  projectRef: string;
  taskKey: string;
  taskNumber: number;
  title: string;
  showTitle: boolean;
  columns: Column[];
  status: string;
  onStatusChange: (status: string) => void;
  watching: boolean;
  watcherCount: number;
  onToggleWatch: () => void;
  onDuplicate: () => void;
  onAddChild: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function TaskTopBar({
  projectName,
  projectRef,
  taskKey,
  taskNumber,
  title,
  showTitle,
  columns,
  status,
  onStatusChange,
  watching,
  watcherCount,
  onToggleWatch,
  onDuplicate,
  onAddChild,
  onDelete,
  onClose,
}: TaskTopBarProps) {
  const ghost =
    "focus-ring rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text";

  return (
    <div
      data-testid="task-top-bar"
      className="@container flex shrink-0 items-center gap-3 border-b border-border
        bg-bg-card px-4 py-2.5 sm:px-5"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Back"
        className="focus-ring -ml-2 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg
          text-text-muted hover:text-text sm:hidden"
      >
        ‹
      </button>

      <div className="flex min-w-0 items-center gap-2 font-mono text-xs text-text-muted">
        <Link
          href={projectPath(projectRef)}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            onClose();
          }}
          className="focus-ring hidden truncate rounded transition-colors hover:text-text sm:inline"
        >
          {projectName}
        </Link>
        <span aria-hidden className="hidden opacity-40 sm:inline">
          /
        </span>
        <span className="text-text">{taskKey}</span>
        <CopyTaskLink projectRef={projectRef} taskNumber={taskNumber} taskKey={taskKey} />
      </div>

      <StatusPill columns={columns} status={status} onChange={onStatusChange} />

      <span
        data-testid="task-top-bar-title"
        aria-hidden={!showTitle}
        className={`hidden min-w-0 flex-1 truncate text-sm font-medium text-text
          transition-opacity duration-150 @min-[600px]:block
          ${showTitle ? "opacity-100" : "opacity-0"}`}
      >
        {title}
      </span>
      <div className="flex-1 @min-[600px]:hidden" />

      <button type="button" onClick={onToggleWatch} className={`hidden lg:block ${ghost}`}>
        {watching ? "Watching" : "Watch"}
        {watcherCount > 0 && <span className="ml-1 opacity-60">({watcherCount})</span>}
      </button>
      <button type="button" onClick={onDuplicate} className={`hidden lg:block ${ghost}`}>
        Duplicate
      </button>

      <div className="lg:hidden">
        <Popover
          label="More actions"
          align="right"
          trigger={({ toggle, open }) => (
            <button
              type="button"
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label="More actions"
              className={`${ghost} flex min-h-[44px] min-w-[44px] items-center justify-center`}
            >
              ···
            </button>
          )}
        >
          {({ close }) => (
            <OptionList label="More actions">
              <OptionItem
                onClick={() => {
                  onToggleWatch();
                  close();
                }}
              >
                {watching ? "Stop watching" : "Watch for changes"}
              </OptionItem>
              <OptionItem
                onClick={() => {
                  onDuplicate();
                  close();
                }}
              >
                Duplicate
              </OptionItem>
              <OptionItem
                onClick={() => {
                  onAddChild();
                  close();
                }}
              >
                Add subtask
              </OptionItem>
              <OptionItem
                danger
                onClick={() => {
                  onDelete();
                  close();
                }}
              >
                Delete task
              </OptionItem>
            </OptionList>
          )}
        </Popover>
      </div>

      <span aria-hidden className="hidden h-5 w-px bg-border sm:block" />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close task"
        className="focus-ring hidden rounded-lg px-2 py-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text sm:block"
      >
        ✕
      </button>
    </div>
  );
}
