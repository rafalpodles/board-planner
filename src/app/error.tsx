"use client";

import { useState } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");

  // The digest is what a server-side error is findable by in the logs, and in a production build
  // it is often all there is — the stack is minified or absent
  const report = [error.message, error.digest && `digest: ${error.digest}`, error.stack]
    .filter(Boolean)
    .join("\n\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4">
      <h2 className="text-xl font-bold text-danger">Something went wrong</h2>
      <p className="max-w-lg text-center text-sm text-text-muted">{error.message}</p>

      <details className="w-full max-w-lg rounded-lg border border-border">
        <summary className="focus-ring cursor-pointer rounded-lg px-4 py-2 text-sm text-text-muted">
          Details
        </summary>
        <pre className="max-h-64 overflow-auto border-t border-border bg-bg-input p-4 text-xs text-text-muted">
          {report}
        </pre>
        <div className="border-t border-border px-4 py-2">
          <button
            type="button"
            onClick={copy}
            className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text"
          >
            {copied === "yes" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy details"}
          </button>
        </div>
      </details>

      <button
        onClick={reset}
        className="focus-ring rounded-lg bg-primary-solid px-4 py-2 text-white"
      >
        Try again
      </button>
    </div>
  );
}
