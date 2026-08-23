"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { saveAllGroups } from "@/lib/save-groups";
import { DirtyGroup } from "./settings-context";

interface SaveBarProps {
  pending: DirtyGroup[];
  total: number;
  onGoToSection: (section: string) => void;
}

export function SaveBar({ pending, total, onGoToSection }: SaveBarProps) {
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
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
      const failed = await saveAllGroups(pending);
      if (failed.length > 0) {
        toast(`Could not save ${failed.join(", ")}`, "error");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    // Sticky inside the content column, not fixed across the viewport: the bar belongs to
    // the settings it saves, and a fixed one runs under the sidebar. max-height rather
    // than a transform so a closed bar reserves no space in the flow.
    <div
      className={`sticky bottom-0 z-40 overflow-hidden transition-[max-height] duration-200
        ${open ? "max-h-56" : "max-h-0 pointer-events-none"}`}
      aria-hidden={!open}
    >
      {/* Padded so the card floats clear of the bottom edge — flush against it, the frame
          reads as cut off and whatever scrolls past shows below it */}
      <div className="px-0.5 pb-3 pt-2">
        <div className="flex w-full flex-wrap items-center gap-3 rounded-xl border border-warning/45 bg-bg-card px-4 py-3 sm:px-6">
          <span className="h-2 w-2 shrink-0 rounded-full bg-warning" />
          <div className="text-sm">
            {view.total === 1
              ? "1 unsaved change"
              : `${view.total} unsaved changes`}
            {view.label && (
              <button
                type="button"
                onClick={() => onGoToSection(view.section)}
                className="flex min-h-11 items-center text-xs text-text-muted hover:text-text hover:underline sm:min-h-0"
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
    </div>
  );
}
