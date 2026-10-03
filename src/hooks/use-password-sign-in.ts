"use client";

import { useEffect, useState } from "react";

/**
 * Whether this instance signs in with passwords (`PASSWORD_SIGN_IN`). Null until the server
 * answers, which a page draws as on — the default — rather than as nothing; assumed on when it
 * cannot answer, since every password endpoint refuses for itself.
 */
export function usePasswordSignIn(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/auth/instance")
      // A 503 still carries the answer: it is read from the environment, not the database
      .then((res) => res.json().catch(() => ({})))
      .then((data: { passwordSignIn?: boolean }) => live && setEnabled(data.passwordSignIn !== false))
      .catch(() => live && setEnabled(true));
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}
