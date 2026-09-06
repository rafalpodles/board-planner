"use client";

import { useRef } from "react";
import { TASK_TITLE_MAX_LENGTH } from "@/lib/identifiers";
import { useAutoGrow } from "./atoms";

interface InlineTitleProps {
  value: string;
  onChange: (value: string) => void;
}

export function InlineTitle({ value, onChange }: InlineTitleProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, value);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      maxLength={TASK_TITLE_MAX_LENGTH}
      aria-label="Task title"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
      }}
      className="focus-ring -ml-1.5 w-full resize-none overflow-hidden rounded-lg bg-transparent px-1.5
        py-0.5 text-2xl font-semibold leading-tight tracking-tight text-text
        transition-colors hover:bg-bg-hover"
    />
  );
}
