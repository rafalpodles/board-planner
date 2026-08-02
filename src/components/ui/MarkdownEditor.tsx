"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Textarea } from "./Textarea";
import { MarkdownContent } from "./MarkdownContent";

interface MarkdownEditorProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  onFileUpload?: (file: File) => Promise<string>;
  placeholder?: string;
  minHeight?: number;
  // Show the rendered text first; click to edit, blur to go back
  previewFirst?: boolean;
}

type Action =
  | { kind: "wrap"; before: string; after: string; placeholder: string }
  | { kind: "prefix"; prefix: string; placeholder: string }
  | { kind: "ordered"; placeholder: string };

const TOOLBAR: { title: string; icon: React.ReactNode; action: Action }[] = [
  {
    title: "Bold (Cmd/Ctrl+B)",
    icon: <span className="font-bold">B</span>,
    action: { kind: "wrap", before: "**", after: "**", placeholder: "bold text" },
  },
  {
    title: "Italic (Cmd/Ctrl+I)",
    icon: <span className="italic font-serif">I</span>,
    action: { kind: "wrap", before: "_", after: "_", placeholder: "italic text" },
  },
  {
    title: "Strikethrough",
    icon: <span className="line-through">S</span>,
    action: { kind: "wrap", before: "~~", after: "~~", placeholder: "struck text" },
  },
  {
    title: "Heading",
    icon: <span className="font-bold text-xs">H2</span>,
    action: { kind: "prefix", prefix: "## ", placeholder: "Heading" },
  },
  {
    title: "Bulleted list",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h.01M4 12h.01M4 18h.01M8 6h12M8 12h12M8 18h12" />
      </svg>
    ),
    action: { kind: "prefix", prefix: "- ", placeholder: "list item" },
  },
  {
    title: "Numbered list",
    icon: <span className="font-mono text-xs">1.</span>,
    action: { kind: "ordered", placeholder: "list item" },
  },
  {
    title: "Task list",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
    action: { kind: "prefix", prefix: "- [ ] ", placeholder: "todo item" },
  },
  {
    title: "Link",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 01-5.656-5.656l1.5-1.5m4.5-4.5l1.5-1.5a4 4 0 015.656 5.656l-3 3" />
      </svg>
    ),
    action: { kind: "wrap", before: "[", after: "](https://)", placeholder: "link text" },
  },
  {
    title: "Inline code",
    icon: <span className="font-mono text-xs">{"</>"}</span>,
    action: { kind: "wrap", before: "`", after: "`", placeholder: "code" },
  },
];

export function MarkdownEditor({
  label,
  value,
  onChange,
  onFileUpload,
  placeholder,
  minHeight = 400,
  previewFirst = false,
}: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pendingSelection = useRef<[number, number] | null>(null);
  // Nothing to render means nothing to preview, so an empty field opens for typing
  const [preview, setPreview] = useState(() => previewFirst && value.trim().length > 0);
  const focusOnEdit = useRef(false);

  useEffect(() => {
    if (preview || !focusOnEdit.current) return;
    focusOnEdit.current = false;
    textareaRef.current?.focus();
  }, [preview]);

  // The caret has to be restored after the new value has actually rendered,
  // otherwise the browser parks it at the end and formats cannot be chained
  useEffect(() => {
    const range = pendingSelection.current;
    const textarea = textareaRef.current;
    if (!range || !textarea) return;
    pendingSelection.current = null;
    textarea.focus();
    textarea.setSelectionRange(range[0], range[1]);
  }, [value]);

  const apply = useCallback(
    (action: Action) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = value.slice(start, end);

      let replacement: string;
      let cursorStart: number;
      let cursorEnd: number;

      if (action.kind === "wrap") {
        const text = selected || action.placeholder;
        replacement = `${action.before}${text}${action.after}`;
        cursorStart = start + action.before.length;
        cursorEnd = cursorStart + text.length;
      } else {
        // Line-based actions prefix every selected line, so a multi-line
        // selection becomes a list rather than one long item
        const lines = (selected || action.placeholder).split("\n");
        replacement = lines
          .map((line, i) => (action.kind === "ordered" ? `${i + 1}. ${line}` : `${action.prefix}${line}`))
          .join("\n");
        cursorStart = start;
        cursorEnd = start + replacement.length;
      }

      pendingSelection.current = [cursorStart, cursorEnd];
      onChange(value.slice(0, start) + replacement + value.slice(end));
    },
    [value, onChange]
  );

  function handlePreviewClick(e: React.MouseEvent<HTMLDivElement>) {
    // Links and GFM task-list checkboxes stay clickable instead of being
    // swallowed as "start editing"
    if ((e.target as HTMLElement).closest("a, input, button")) return;
    focusOnEdit.current = true;
    setPreview(false);
  }

  function handleBlur(e: React.FocusEvent<HTMLTextAreaElement>) {
    // Focus moving to the attach-file button (or any control of this editor) is
    // not leaving the field — collapsing here would unmount it before its click
    if (containerRef.current?.contains(e.relatedTarget)) return;
    if (value.trim()) setPreview(true);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key !== "b" && key !== "i") return;
    e.preventDefault();
    apply(
      key === "b"
        ? { kind: "wrap", before: "**", after: "**", placeholder: "bold text" }
        : { kind: "wrap", before: "_", after: "_", placeholder: "italic text" }
    );
  }

  return (
    <div ref={containerRef} className="w-full">
      {label && <label className="block text-sm font-medium text-text-muted mb-1">{label}</label>}

      <div className="flex items-center gap-0.5 flex-wrap border border-border border-b-0 rounded-t-lg bg-bg-card px-1.5 py-1">
        {TOOLBAR.map((item) => (
          <button
            key={item.title}
            type="button"
            title={item.title}
            disabled={preview}
            // Without this the button takes focus on mousedown and the textarea
            // selection is gone by the time the click handler runs
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => apply(item.action)}
            className="w-7 h-7 flex items-center justify-center rounded text-text-muted
              hover:text-text hover:bg-bg-input transition-colors cursor-pointer
              disabled:opacity-40 disabled:cursor-default"
          >
            {item.icon}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPreview((p) => !p)}
          className={`ml-auto text-xs px-2 py-1 rounded transition-colors cursor-pointer ${
            preview ? "chip" : "text-text-muted hover:text-text hover:bg-bg-input"
          }`}
        >
          {preview ? "Edit" : "Preview"}
        </button>
      </div>

      {preview ? (
        <div
          onClick={previewFirst ? handlePreviewClick : undefined}
          title={previewFirst ? "Click to edit" : undefined}
          className={`w-full rounded-b-lg border border-border bg-bg-input px-3 py-2 overflow-y-auto prose prose-sm max-w-none ${
            previewFirst ? "cursor-text hover:border-primary/50 transition-colors" : ""
          }`}
          style={{ minHeight }}
        >
          {value.trim() ? (
            <MarkdownContent>{value}</MarkdownContent>
          ) : (
            <p className="text-sm text-text-muted">Nothing to preview yet.</p>
          )}
        </div>
      ) : (
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={previewFirst ? handleBlur : undefined}
          onFileUpload={onFileUpload}
          placeholder={placeholder}
          className="rounded-t-none"
          style={{ minHeight }}
        />
      )}
    </div>
  );
}
