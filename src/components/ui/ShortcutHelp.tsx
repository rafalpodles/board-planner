"use client";

import { useEffect, useRef } from "react";

interface ShortcutHelpProps {
  open: boolean;
  onClose: () => void;
}

// The same dialog is shown in both views, so anything that only works in one of
// them is listed under that view rather than claimed everywhere
const SHORTCUT_GROUPS = [
  {
    title: "Anywhere",
    shortcuts: [
      { key: "N", description: "Create new task" },
      { key: "⌘K / /", description: "Search tasks and projects" },
      { key: "V", description: "Toggle view: board ↔ list" },
      { key: "R", description: "Refresh board" },
      { key: "Esc", description: "Close dialogs / clear selection" },
      { key: "?", description: "Show this help" },
    ],
  },
  {
    title: "Board",
    shortcuts: [
      { key: "Tab", description: "Move between cards" },
      { key: "Enter / Space", description: "Open the focused card" },
      { key: "⇧ Enter", description: "Add the focused card to the selection" },
      { key: "⇧ Click", description: "Add a card to the selection" },
      { key: "⌘ / Ctrl Click", description: "Open a card in a new tab" },
      { key: "Middle click", description: "Open a card in a new tab" },
    ],
  },
  {
    title: "List",
    shortcuts: [
      { key: "J / K", description: "Move between rows" },
      { key: "Enter", description: "Open the focused row" },
    ],
  },
];

export function ShortcutHelp({ open, onClose }: ShortcutHelpProps) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCloseRef.current();
    }
    // BP-522: subscribing on onClose too would resubscribe mid-dispatch, whenever a sibling
    // keydown listener renders the parent first — and a listener added during a dispatch does
    // not see that event, so Escape never reached this handler.
    //
    // `?` is deliberately not handled here: the board owns that key as a toggle, and two
    // listeners acting on one press reopen the dialog whenever the board's runs second
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border rounded-xl shadow-xl p-6 max-w-md w-full mx-4
          max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">Keyboard Shortcuts</h2>
        <div className="space-y-4">
          {SHORTCUT_GROUPS.map(({ title, shortcuts }) => (
            <section key={title}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">
                {title}
              </h3>
              <div className="space-y-2">
                {shortcuts.map(({ key, description }) => (
                  <div key={key} className="flex items-center justify-between gap-4">
                    <span className="text-sm text-text-muted">{description}</span>
                    <kbd className="text-xs bg-bg-input border border-border px-2 py-1 rounded font-mono whitespace-nowrap">
                      {key}
                    </kbd>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
        <p className="text-xs text-text-muted mt-4">
          Shortcuts are disabled when typing in inputs.
        </p>
      </div>
    </div>
  );
}
