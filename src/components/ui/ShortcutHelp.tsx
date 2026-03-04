"use client";

import { useEffect } from "react";

interface ShortcutHelpProps {
  open: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  { key: "N", description: "Create new task" },
  { key: "J / K", description: "Navigate tasks (list view)" },
  { key: "Enter", description: "Open focused task" },
  { key: "/", description: "Focus search" },
  { key: "V", description: "Toggle board/list view" },
  { key: "R", description: "Refresh board" },
  { key: "Esc", description: "Close dialogs / clear selection" },
  { key: "?", description: "Show this help" },
];

export function ShortcutHelp({ open, onClose }: ShortcutHelpProps) {
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border rounded-xl shadow-xl p-6 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">Keyboard Shortcuts</h2>
        <div className="space-y-2">
          {SHORTCUTS.map(({ key, description }) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-sm text-text-muted">{description}</span>
              <kbd className="text-xs bg-bg-input border border-border px-2 py-1 rounded font-mono">
                {key}
              </kbd>
            </div>
          ))}
        </div>
        <p className="text-xs text-text-muted mt-4">
          Shortcuts are disabled when typing in inputs.
        </p>
      </div>
    </div>
  );
}
