"use client";

import { useEffect } from "react";

let pendingLeave: string | null = null;
// A link whose own handler navigates in code would otherwise be asked about twice
let approvedThisClick = false;

export function mayLeave(): boolean {
  return pendingLeave === null || approvedThisClick || window.confirm(pendingLeave);
}

// Back is not covered: it navigates on `popstate`, which cannot be cancelled
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
        return;
      }
      approvedThisClick = true;
      setTimeout(() => {
        approvedThisClick = false;
      });
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
