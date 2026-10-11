"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/hooks/use-auth";
import { CONTACT_EMAIL } from "@/lib/brand";

export function OrganisationSuspended() {
  const heading = useRef<HTMLHeadingElement>(null);
  const { logout } = useAuth();
  const [address, setAddress] = useState("");
  const [leaving, setLeaving] = useState(false);
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => setAddress(window.location.host), []);

  async function signOut() {
    setLeaving(true);
    const signIn = await logout();
    window.location.assign(signIn ?? "/login");
  }

  return (
    <div className="flex items-center justify-center min-h-screen px-4">
      <div role="status" className="w-full max-w-sm text-center">
        <h1 ref={heading} tabIndex={-1} className="text-lg font-semibold mb-2">
          This organisation is suspended
        </h1>
        {address && (
          <p className="text-sm text-text-muted mb-2" data-testid="suspended-address">
            {address}
          </p>
        )}
        <p className="text-sm text-text mb-4">
          Its boards and data are kept, but nobody can sign in or use them until the service lifts the
          suspension. Write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
            {CONTACT_EMAIL}
          </a>
          .
        </p>
        <Button variant="secondary" onClick={() => void signOut()} disabled={leaving}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
