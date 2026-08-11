"use client";

import { useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { GrowingTextarea } from "./atoms";
import { useEditorTriggers } from "@/hooks/use-editor-triggers";
import { useTriggerAutocomplete } from "@/hooks/use-trigger-autocomplete";
import { SuggestionList } from "@/components/ui/SuggestionList";

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const triggers = useEditorTriggers(projectId, projectKey);
  const autocomplete = useTriggerAutocomplete(triggers, textareaRef, setBody);

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
      className="sticky bottom-0 z-10 flex items-end gap-2 border-t border-border bg-bg-card relative
        px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden"
    >
      <SuggestionList
        items={autocomplete.items}
        index={autocomplete.index}
        onPick={autocomplete.choose}
        onHover={autocomplete.setIndex}
      />
      <GrowingTextarea
        textareaRef={textareaRef}
        value={body}
        onChange={(next) => {
          setBody(next);
          autocomplete.detect(next, textareaRef.current?.selectionStart ?? next.length);
        }}
        onBlur={() => setTimeout(autocomplete.close, 150)}
        aria-label="Add a comment"
        placeholder="Add a comment…"
        onKeyDown={(e) => {
          // The list owns the arrows and Enter while it is open, so picking a suggestion is not
          // also a send
          autocomplete.onKeyDown(e);
          if (e.defaultPrevented) return;
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
