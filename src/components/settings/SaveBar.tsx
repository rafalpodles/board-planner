"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { DirtyGroup } from "./settings-context";

interface SaveBarProps {
  pending: DirtyGroup[];
  total: number;
  onGoToSection: (section: string) => void;
}

export function SaveBar({ pending, total, onGoToSection }: SaveBarProps) {
  const [saving, setSaving] = useState(false);
  const open = total > 0;
  const first = pending[0];

  // Hold the last real summary so the bar doesn't read "0 unsaved changes" while it slides away
  const shown = useRef({ total: 0, label: "", section: "", more: 0 });
  if (open) {
    shown.current = {
      total,
      label: first?.label ?? "",
      section: first?.section ?? "",
      more: pending.length - 1,
    };
  }
  const view = shown.current;

  async function saveAll() {
    setSaving(true);
    try {
      for (const group of pending) {
        await group.save();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-40 border-t border-warning/45 bg-bg-card/95 backdrop-blur
        transition-transform duration-200 ${open ? "translate-y-0" : "translate-y-full pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div className="mx-auto flex w-full max-w-[1160px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <span className="h-2 w-2 shrink-0 rounded-full bg-warning" />
        <div className="text-sm">
          {view.total === 1 ? "1 unsaved change" : `${view.total} unsaved changes`}
          {view.label && (
            <button
              type="button"
              onClick={() => onGoToSection(view.section)}
              className="block text-xs text-text-muted hover:text-text hover:underline"
            >
              {view.label}
              {view.more > 0 ? ` and ${view.more} more` : ""}
            </button>
          )}
        </div>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="secondary"
          disabled={saving || !open}
          onClick={() => pending.forEach((g) => g.discard())}
        >
          Discard
        </Button>
        <Button size="sm" disabled={saving || !open} onClick={saveAll}>
          {saving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
