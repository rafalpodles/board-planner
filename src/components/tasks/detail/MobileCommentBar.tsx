"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { useEditorTriggers } from "@/hooks/use-editor-triggers";
import { AutocompleteTextarea } from "@/components/ui/AutocompleteTextarea";

interface MobileCommentBarProps {
  projectId: string;
  taskId: string;
  onPosted: () => void;
  /** The board's key, so this composer offers task references like the wide one does */
  projectKey?: string;
}

/**
 * The phone's comment box: pinned to the bottom of the task for the whole scroll,
 * because commenting is the common action and hunting for the field at the end of
 * the page is the thing the design set out to remove.
 */
export function MobileCommentBar({
  projectId,
  taskId,
  onPosted,
  projectKey,
}: MobileCommentBarProps) {
  const api = useApi();
  const { toast } = useToast();
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);

  // A phone comments through this bar and never sees the wide composer, so wiring the autocomplete
  // only there left the whole feature — including @mention, which predates it — off mobile entirely
  const triggers = useEditorTriggers(projectId, projectKey);

  async function post() {
    const text = body.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      await api.post(`/api/projects/${projectId}/tasks/${taskId}/comments`, { body: text });
      setBody("");
      onPosted();
    } catch {
      toast("Failed to post comment", "error");
    } finally {
      setPosting(false);
    }
  }

  return (
    <div
      // Declares the bottom strip as spoken for. Anything the shell floats down there stands clear
      // of a bar carrying this, rather than each side guessing at the other's geometry (BP-591).
      data-pinned-bottom-bar
      className="sticky bottom-0 z-10 flex items-end gap-2 border-t border-border bg-bg-card relative
        px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden"
    >
      <AutocompleteTextarea
        value={body}
        triggers={triggers}
        onChange={setBody}
        aria-label="Add a comment"
        placeholder="Add a comment…"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            post();
          }
        }}
        className="focus-ring max-h-32 min-h-[44px] flex-1 rounded-2xl border border-border bg-bg-input
          px-4 py-3 text-sm text-text placeholder:text-text-muted"
      />
      <button
        type="button"
        onClick={post}
        disabled={!body.trim() || posting}
        aria-label="Post comment"
        className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-full
          bg-primary-solid text-white transition-opacity hover:bg-primary-solid-hover
          disabled:opacity-40"
      >
        ↑
      </button>
    </div>
  );
}
