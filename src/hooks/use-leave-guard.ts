"use client";

import { useEffect } from "react";

let pendingLeave: string | null = null;

/**
 * For navigation the app starts itself with `router.push` or `router.replace` — a task opened from
 * search, a sign-out. Nothing in the App Router can hold those, so each such caller asks here first.
 */
export function mayLeave(): boolean {
  return pendingLeave === null || window.confirm(pendingLeave);
}

/**
 * Asks before leaving a page that holds work nobody has saved.
 *
 * Three routes out are covered: `beforeunload` for a reload, a closed tab, a typed address and any
 * full document load; a capture-phase listener for a click on an in-app link, which the App Router
 * follows without unloading anything; and `mayLeave` for callers that navigate in code. The
 * browser's Back button is not: it navigates on `popstate`, which cannot be cancelled.
 */
export function useLeaveGuard(dirty: boolean, message: string) {
  useEffect(() => {
    if (!dirty) return;
    pendingLeave = message;

    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const anchor = (e.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank") return;
      const next = new URL(anchor.href, window.location.href);
      if (next.origin !== window.location.origin) return;
      if (next.pathname === window.location.pathname && next.search === window.location.search) return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      if (pendingLeave === message) pendingLeave = null;
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, message]);
}
