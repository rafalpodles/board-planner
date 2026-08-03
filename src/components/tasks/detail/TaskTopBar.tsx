"use client";

import { Popover } from "@/components/ui/Popover";
import { StatusPill } from "./StatusPill";
import { OptionItem, OptionList } from "./FieldRow";

interface Column {
  id: string;
  label: string;
  color: string;
}

interface TaskTopBarProps {
  projectName: string;
  taskKey: string;
  columns: Column[];
  status: string;
  onStatusChange: (status: string) => void;
  watching: boolean;
  watcherCount: number;
  onToggleWatch: () => void;
  onDuplicate: () => void;
  onAddChild: () => void;
  onClose: () => void;
}

export function TaskTopBar({
  projectName,
  taskKey,
  columns,
  status,
  onStatusChange,
  watching,
  watcherCount,
  onToggleWatch,
  onDuplicate,
  onAddChild,
  onClose,
}: TaskTopBarProps) {
  const ghost =
    "focus-ring rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text";

  return (
    <div className="flex items-center gap-3 border-b border-border bg-bg-card px-4 py-2.5 sm:px-5">
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
        <span className="hidden truncate sm:inline">{projectName}</span>
        <span aria-hidden className="hidden opacity-40 sm:inline">
          /
        </span>
        <span className="text-text">{taskKey}</span>
      </div>

      <StatusPill columns={columns} status={status} onChange={onStatusChange} />

      <div className="flex-1" />

      <button type="button" onClick={onToggleWatch} className={`hidden sm:block ${ghost}`}>
        {watching ? "Watching" : "Watch"}
        {watcherCount > 0 && <span className="ml-1 opacity-60">({watcherCount})</span>}
      </button>
      <button type="button" onClick={onDuplicate} className={`hidden sm:block ${ghost}`}>
        Duplicate
      </button>

      {/* Narrow screens only: everything in here has its own control once there is
          room — Watch and Duplicate above, Add subtask in the linked-work section */}
      <div className="sm:hidden">
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
