"use client";

import { useEffect, useRef } from "react";
import { TASK_STATUSES, STATUS_LABELS, TaskStatus } from "@/types";

interface TaskContextMenuProps {
  x: number;
  y: number;
  currentStatus: TaskStatus;
  onStatusChange: (status: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function TaskContextMenu({
  x,
  y,
  currentStatus,
  onStatusChange,
  onDuplicate,
  onDelete,
  onClose,
}: TaskContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  const style: React.CSSProperties = {
    position: "fixed",
    left: x,
    top: y,
    zIndex: 100,
  };

  return (
    <div
      ref={ref}
      style={style}
      className="bg-bg-card border border-border rounded-lg shadow-lg py-1 min-w-[160px] text-sm"
    >
      <div className="px-3 py-1.5 text-xs text-text-muted font-medium">
        Move to
      </div>
      {TASK_STATUSES.filter((s) => s !== currentStatus).map((s) => (
        <button
          key={s}
          onClick={() => { onStatusChange(s); onClose(); }}
          className="w-full text-left px-3 py-1.5 hover:bg-bg-input transition-colors"
        >
          {STATUS_LABELS[s]}
        </button>
      ))}
      <div className="border-t border-border my-1" />
      <button
        onClick={() => { onDuplicate(); onClose(); }}
        className="w-full text-left px-3 py-1.5 hover:bg-bg-input transition-colors"
      >
        Duplicate
      </button>
      <button
        onClick={() => { onDelete(); onClose(); }}
        className="w-full text-left px-3 py-1.5 hover:bg-bg-input transition-colors text-danger"
      >
        Delete
      </button>
    </div>
  );
}
