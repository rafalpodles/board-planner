"use client";

import { useEffect, useRef, useState } from "react";
import { ApiProjectColumn, ApiSprint } from "@/types";
import { effectiveColumns } from "@/lib/columns";

interface TaskContextMenuProps {
  x: number;
  y: number;
  currentStatus: string;
  sprints?: ApiSprint[];
  columns?: ApiProjectColumn[];
  currentSprint?: string | null;
  selectedCount?: number;
  onStatusChange: (status: string) => void;
  onSprintChange?: (sprintId: string | null) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function TaskContextMenu({
  x,
  y,
  currentStatus,
  sprints = [],
  columns,
  currentSprint,
  selectedCount = 1,
  onStatusChange,
  onSprintChange,
  onDuplicate,
  onDelete,
  onClose,
}: TaskContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    // BP-522: a dep on onClose resubscribes mid-dispatch, and a listener added during a
    // dispatch never sees that event
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width > vw) left = vw - rect.width - 8;
    if (top + rect.height > vh) top = vh - rect.height - 8;
    if (left < 0) left = 8;
    if (top < 0) top = 8;
    if (left !== x || top !== y) setPosition({ left, top });
  }, [x, y]);

  const style: React.CSSProperties = {
    position: "fixed",
    left: position.left,
    top: position.top,
    zIndex: 100,
  };

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="task-context-menu"
      style={style}
      className="bg-bg-card border border-border rounded-lg shadow-lg py-1 min-w-[160px] text-sm"
    >
      {selectedCount > 1 && (
        <div className="px-3 py-1.5 text-xs font-medium text-primary border-b border-border mb-1">
          {selectedCount} tasks selected
        </div>
      )}
      <div className="px-3 py-1.5 text-xs text-text-muted font-medium">
        Move to
      </div>
      {effectiveColumns(columns).filter((c) => selectedCount > 1 || c.id !== currentStatus).map((c) => (
        <button
          key={c.id}
          onClick={() => { onStatusChange(c.id); onClose(); }}
          className="w-full text-left px-3 py-1.5 hover:bg-bg-input transition-colors"
        >
          {c.label}
        </button>
      ))}
      {onSprintChange && sprints.length > 0 && (
        <>
          <div className="border-t border-border my-1" />
          <div className="px-3 py-1.5 text-xs text-text-muted font-medium">
            Move to sprint
          </div>
          {sprints.map((s) => (
            <button
              key={s._id}
              disabled={selectedCount === 1 && s._id === currentSprint}
              onClick={() => { onSprintChange(s._id); onClose(); }}
              className="w-full text-left px-3 py-1.5 hover:bg-bg-input transition-colors
                disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-default"
            >
              {s.name}
              {s.status === "active" && (
                <span className="text-xs text-primary ml-1">(Active)</span>
              )}
            </button>
          ))}
          {(currentSprint || selectedCount > 1) && (
            <button
              onClick={() => { onSprintChange(null); onClose(); }}
              className="w-full text-left px-3 py-1.5 hover:bg-bg-input transition-colors text-text-muted"
            >
              Remove from sprint
            </button>
          )}
        </>
      )}
      <div className="border-t border-border my-1" />
      {selectedCount === 1 && (
        <button
          onClick={() => { onDuplicate(); onClose(); }}
          className="w-full text-left px-3 py-1.5 hover:bg-bg-input transition-colors"
        >
          Duplicate
        </button>
      )}
      <button
        onClick={() => { onDelete(); onClose(); }}
        className="w-full text-left px-3 py-1.5 hover:bg-bg-input transition-colors text-danger"
      >
        {selectedCount > 1 ? `Delete ${selectedCount} tasks` : "Delete"}
      </button>
    </div>
  );
}
