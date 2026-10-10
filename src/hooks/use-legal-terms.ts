"use client";

import { useEffect, useState } from "react";
import type { LegalTerms } from "@/types";

/** undefined until the server has answered, null where no terms are published */
export function useLegalTerms(): LegalTerms | null | undefined {
  const [terms, setTerms] = useState<LegalTerms | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    fetch("/api/legal/terms")
      .then(async (res) => (res.ok ? ((await res.json()) as { terms?: LegalTerms | null }) : null))
      .then((data) => live && data && setTerms(data.terms ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return terms;
}
