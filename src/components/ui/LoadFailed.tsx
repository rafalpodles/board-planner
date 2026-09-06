"use client";

import { Button } from "@/components/ui/Button";

/**
 * A read that never answered supports no claim about the data. The toast fades after three
 * seconds; this stays until somebody has an answer, and offers the read again rather than a
 * reload (BP-548, BP-577).
 *
 * `block` stands in for content that is not there. `row` sits above content that is — a banner
 * saying what is on screen may be stale, which a centred block reads as a broken empty state.
 */
export function LoadFailed({
  message,
  onRetry,
  busy = false,
  variant = "block",
  className = "",
  testId,
}: {
  message: string;
  onRetry: () => void;
  busy?: boolean;
  variant?: "block" | "row";
  className?: string;
  testId?: string;
}) {
  const shape =
    variant === "row"
      ? "flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-left"
      : "flex flex-col items-center justify-center gap-3 text-center";

  return (
    // The alert is the whole region, so a screen reader hears the Retry along with the failure
    <div
      role="alert"
      data-testid={testId}
      className={`${shape} ${className || (variant === "row" ? "mb-4" : "py-8")}`}
    >
      <p className="text-sm text-text-muted">{message}</p>
      <Button
        size="sm"
        className="shrink-0"
        disabled={busy}
        variant={variant === "row" ? "secondary" : "primary"}
        onClick={onRetry}
      >
        {busy ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
