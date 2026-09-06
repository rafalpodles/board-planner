"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";

const FEEDBACK_MS = 2000;

/** Next's own types promise an Error; its client code says it does not guarantee one. */
function readReport(error: unknown): { message: string; report: string } {
  const carried = (error ?? {}) as { message?: unknown; stack?: unknown; digest?: unknown };
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : "");

  const message = text(carried.message);
  const digest = text(carried.digest);
  const stack = text(carried.stack);
  const report = [message, digest && `digest: ${digest}`, stack].filter(Boolean).join("\n\n");

  return {
    message: message || "The page could not be rendered.",
    // A thrown string or object carries none of the three, and a report of "" copied to the
    // clipboard under a button that says Copied is worse than saying there is nothing to copy
    report: report || "Nothing was reported beyond the failure itself.",
  };
}

export default function GlobalError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  // Stable since Next 16.3 and what the docs ask for: it re-fetches before re-rendering, where
  // reset only re-renders — which for a server component means the same broken payload again
  retry?: () => void;
  reset: () => void;
}) {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { message, report } = readReport(error);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function show(next: "yes" | "failed") {
    setCopied(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied("no"), FEEDBACK_MS);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      show("yes");
    } catch {
      show("failed");
    }
  }

  const copyResult = copied === "yes" ? "Copied" : copied === "failed" ? "Copy failed" : "";

  return (
    <div
      data-testid="error-boundary"
      className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4"
    >
      <h2 className="text-xl font-bold text-danger">Something went wrong</h2>
      <p className="max-w-lg text-center text-sm break-words text-text-muted">{message}</p>

      <details className="w-full max-w-lg rounded-lg border border-border">
        <summary className="focus-ring-inset cursor-pointer rounded-lg px-4 py-2.5 text-sm text-text-muted">
          Details
        </summary>
        <pre className="max-h-64 overflow-auto border-t border-border bg-bg-input p-4 text-xs text-text-muted">
          {report}
        </pre>
        <div className="border-t border-border px-4 py-2">
          <Button type="button" variant="secondary" size="sm" aria-label="Copy details" onClick={copy}>
            {copyResult || "Copy details"}
            <span aria-live="polite" className="sr-only">
              {copyResult}
            </span>
          </Button>
        </div>
      </details>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={() => (retry ?? reset)()}>
          Try again
        </Button>
        {/* The boundary replaces the whole shell — sidebar, navigation and all — so without this
            the only way out of a failure that repeats is the browser's back button */}
        <Link href="/projects" className="focus-ring rounded-lg px-3 py-2 text-sm text-text-muted hover:text-text">
          Go to projects
        </Link>
      </div>
    </div>
  );
}
