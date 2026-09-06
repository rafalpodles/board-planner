"use client";

import { ReactNode } from "react";
import { Modal } from "@/components/ui/Modal";

interface ShortcutHelpProps {
  open: boolean;
  onClose: () => void;
  readOnly?: boolean;
  pinViewMode?: "board" | "list";
}

interface Shortcut {
  key: string;
  description: string;
  // Which prop makes this row dead, so it is hidden instead of advertising a key that does nothing
  hideWhen?: "readOnly" | "pinViewMode";
}

// The same dialog is shown in both views, so anything that only works in one of
// them is listed under that view rather than claimed everywhere
const SHORTCUT_GROUPS: { title: string; shortcuts: Shortcut[] }[] = [
  {
    title: "Anywhere",
    shortcuts: [{ key: "⌘K / /", description: "Search tasks and projects" }],
  },
  {
    title: "Board",
    shortcuts: [
      { key: "N", description: "Create new task", hideWhen: "readOnly" },
      { key: "V", description: "Toggle view: board ↔ list", hideWhen: "pinViewMode" },
      { key: "R", description: "Refresh board" },
      { key: "Esc", description: "Close dialogs / clear selection" },
      { key: "?", description: "Show this help" },
    ],
  },
  {
    title: "Cards",
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

// VoiceOver/NVDA misread or drop ⌘/⇧ — each glyph gets a visually-hidden spoken label too.
const GLYPH_LABELS: Record<string, string> = {
  "⌘": "Cmd",
  "⇧": "Shift",
  "↔": "left-right",
};

// Alternation in a capturing group, not a [character class]: a class breaks silently if a
// future glyph is ever a regex metacharacter like ^ ] - or \, and the capture keeps the glyph
// itself in the split result so one pass finds and places it.
const GLYPH_PATTERN = new RegExp(
  `(${Object.keys(GLYPH_LABELS)
    .map((glyph) => glyph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})`,
  "g"
);

function withGlyphLabels(text: string): ReactNode[] {
  return text.split(GLYPH_PATTERN).map((part, i) =>
    GLYPH_LABELS[part] ? (
      <span key={i}>
        <span aria-hidden="true">{part}</span>
        <span className="sr-only">{GLYPH_LABELS[part]}</span>
      </span>
    ) : (
      part
    )
  );
}

export function ShortcutHelp({ open, onClose, readOnly = false, pinViewMode }: ShortcutHelpProps) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard Shortcuts" size="sm">
      <div className="space-y-4">
        {SHORTCUT_GROUPS.map(({ title, shortcuts }) => {
          const visible = shortcuts.filter((s) => {
            if (s.hideWhen === "readOnly" && readOnly) return false;
            if (s.hideWhen === "pinViewMode" && pinViewMode) return false;
            return true;
          });
          if (visible.length === 0) return null;
          return (
            <section key={title}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">
                {title}
              </h3>
              <dl className="space-y-2">
                {visible.map(({ key, description }) => (
                  <div key={key} className="flex items-center justify-between gap-4">
                    <dt className="text-sm text-text-muted">{withGlyphLabels(description)}</dt>
                    <dd className="m-0">
                      <kbd className="text-xs bg-bg-input border border-border px-2 py-1 rounded font-mono whitespace-nowrap">
                        {withGlyphLabels(key)}
                      </kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
      <p className="text-xs text-text-muted mt-4">Shortcuts are disabled when typing in inputs.</p>
    </Modal>
  );
}
