"use client";

import { useEffect, useRef } from "react";
import { APP_NAME } from "@/lib/brand";

interface Claim {
  title: string | null;
}

const claims: Claim[] = [];

function applyTitle() {
  const top = claims.findLast((claim) => claim.title !== null);
  document.title = top?.title ?? APP_NAME;
}

// The caller mounted last owns the tab: a task modal keeps it while the board underneath re-titles itself
export function useDocumentTitle(title: string | null) {
  const claim = useRef<Claim | null>(null);

  useEffect(() => {
    const mine: Claim = { title: null };
    claims.push(mine);
    claim.current = mine;
    return () => {
      claims.splice(claims.indexOf(mine), 1);
      claim.current = null;
      applyTitle();
    };
  }, []);

  useEffect(() => {
    if (!claim.current) return;
    claim.current.title = title;
    applyTitle();
  }, [title]);
}
