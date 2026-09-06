"use client";

import { Button } from "@/components/ui/Button";

/**
 * A read that never answered supports no claim about the data. The toast fades after three
 * seconds; this stays until somebody has an answer, and offers the read again rather than a
 * reload (BP-548, BP-577).
 */
export function LoadFailed({
  message,
  onRetry,
  className = "py-8",
  testId,
}: {
  message: string;
  onRetry: () => void;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`flex flex-col items-center justify-center gap-3 text-center ${className}`}
    >
      <p role="alert" className="text-sm text-text-muted">
        {message}
      </p>
      <Button size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
