"use client";

import { useState } from "react";
import { MarkdownContent } from "@/components/ui/MarkdownContent";
import { MarkdownEditor } from "@/components/ui/MarkdownEditor";
import { SectionLabel } from "./atoms";

interface DescriptionSectionProps {
  value: string;
  onChange: (value: string) => void;
  onFileUpload: (file: File) => Promise<string>;
  /** Narrow screens show three lines behind a Show more, so the criteria stay in reach */
  collapsible?: boolean;
}

export function DescriptionSection({
  value,
  onChange,
  onFileUpload,
  collapsible = false,
}: DescriptionSectionProps) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Clamped on narrow screens only — the rail layout has room for the whole thing
  const clamped = collapsible && !expanded ? "line-clamp-3 lg:line-clamp-none" : "";

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <SectionLabel>Description</SectionLabel>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="focus-ring rounded-md border border-border px-2.5 py-1 text-xs text-text-muted
            transition-colors hover:bg-bg-hover hover:text-text"
        >
          {editing ? "Done" : "Edit"}
        </button>
      </div>

      {editing ? (
        <MarkdownEditor
          value={value}
          onChange={onChange}
          onFileUpload={onFileUpload}
          placeholder="Markdown supported — use the toolbar, or Cmd/Ctrl+B and Cmd/Ctrl+I"
        />
      ) : value.trim() ? (
        <>
          <div className={`prose prose-sm max-w-none text-sm leading-relaxed ${clamped}`}>
            <MarkdownContent>{value}</MarkdownContent>
          </div>
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="focus-ring self-start rounded-md text-sm font-medium text-primary lg:hidden"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="focus-ring -mx-1.5 rounded-lg px-1.5 py-1 text-left text-sm text-text-muted hover:bg-bg-hover"
        >
          Add a description…
        </button>
      )}
    </section>
  );
}
