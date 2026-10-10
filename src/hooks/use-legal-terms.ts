"use client";

import { useCallback, useEffect, useState } from "react";
import type { LegalTerms } from "@/types";

export interface LegalTermsState {
  /** undefined until the server has answered, null where no terms are published */
  terms: LegalTerms | null | undefined;
  failed: boolean;
  retry: () => void;
}

export function useLegalTerms(): LegalTermsState {
  const [terms, setTerms] = useState<LegalTerms | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    fetch("/api/legal/terms")
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as { terms?: LegalTerms | null };
      })
      .then((data) => {
        if (!live) return;
        setTerms(data.terms ?? null);
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((n) => n + 1);
  }, []);

  return { terms, failed, retry };
}
