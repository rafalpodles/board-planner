"use client";

import { useSelectedLayoutSegment } from "next/navigation";

/**
 * The intercepting modal is an overlay on whatever the page underneath is showing. When that is
 * already a task, it is the same task: a soft navigation from one task to another re-renders the
 * `children` slot for the new param *and* is intercepted into `@modal`, so the copy (BP-521), or
 * any task reached from a link in the detail view, is drawn twice — two title editors, two
 * comment composers, and a close button that lands on the task the person navigated away from.
 */
export function ModalOverPage({ children }: { children: React.ReactNode }) {
  return useSelectedLayoutSegment("children") === "tasks" ? null : children;
}
