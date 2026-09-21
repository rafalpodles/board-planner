"use client";

import { useEffect } from "react";

const pending: string[] = [];
// Once a person has said yes, the same leave is not asked about again: not by a link's own
// handler navigating in code, and not by the browser's prompt on the full load that follows
const APPROVAL_MS = 1_000;
let approvedAt = 0;

function approve() {
  approvedAt = Date.now();
}

const approved = () => Date.now() - approvedAt < APPROVAL_MS;

export function mayLeave(): boolean {
  const message = pending.at(-1);
  if (message === undefined || approved()) return true;
  if (!window.confirm(message)) return false;
  approve();
  return true;
}

// Back is not covered: it navigates on `popstate`, which cannot be cancelled
export function useLeaveGuard(dirty: boolean, message: string) {
  useEffect(() => {
    if (!dirty) return;
    pending.push(message);

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!approved()) e.preventDefault();
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const anchor = (e.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank") return;
      const next = new URL(anchor.href, window.location.href);
      if (next.origin !== window.location.origin) return;
      if (next.pathname === window.location.pathname && next.search === window.location.search) return;
      if (!mayLeave()) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      pending.splice(pending.lastIndexOf(message), 1);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, message]);
}
