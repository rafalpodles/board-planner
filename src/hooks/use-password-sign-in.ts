"use client";

import { useEffect, useState } from "react";

/**
 * Whether this instance signs in with passwords (`PASSWORD_SIGN_IN`). Null until the server
 * answers; assumed on when it cannot, since every password endpoint refuses for itself.
 */
export function usePasswordSignIn(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/auth/instance")
      .then((res) => (res.ok ? res.json() : {}))
      .then((data: { passwordSignIn?: boolean }) => live && setEnabled(data.passwordSignIn !== false))
      .catch(() => live && setEnabled(true));
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}
