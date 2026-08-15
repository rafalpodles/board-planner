"use client";

import { useEffect, useRef, useState } from "react";
import { taskPath } from "@/lib/urls";

const FEEDBACK_MS = 2000;

interface CopyTaskLinkProps {
  projectRef: string;
  taskNumber: number;
  taskKey: string;
  className?: string;
}

type Result = "idle" | "copied" | "failed";

export function CopyTaskLink({ projectRef, taskNumber, taskKey, className = "" }: CopyTaskLinkProps) {
  const [result, setResult] = useState<Result>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  function show(next: Result) {
    setResult(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult("idle"), FEEDBACK_MS);
  }

  async function copy() {
    const url = new URL(taskPath(projectRef, taskNumber), window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      show("copied");
    } catch {
      show("failed");
    }
  }

  const label =
    result === "copied" ? "Copied!" : result === "failed" ? "Copy failed" : `Copy link to ${taskKey}`;

  return (
    <button
      type="button"
      aria-label={`Copy link to ${taskKey}`}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        copy();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        // Same collision as the card's own Enter: the board's handler sits on the
        // node React delegates from, which only the native stop reaches
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
      }}
      className={`focus-ring relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded
        text-text-muted opacity-60 transition-colors hover:bg-bg-hover hover:text-text hover:opacity-100
        focus-visible:opacity-100
        after:absolute after:left-1/2 after:top-1/2 after:h-9 after:w-9 after:-translate-x-1/2
        after:-translate-y-1/2 after:content-[''] sm:after:hidden
        ${result === "copied" ? "text-success opacity-100" : ""}
        ${result === "failed" ? "text-danger opacity-100" : ""}
        ${className}`}
    >
      {result === "copied" ? (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
      )}
      <span aria-live="polite" className="sr-only">
        {result === "idle" ? "" : label}
      </span>
    </button>
  );
}
