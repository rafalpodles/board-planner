"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/hooks/use-auth";
import { CONTACT_EMAIL } from "@/lib/brand";
import { NotFoundExperience } from "@/components/not-found/NotFoundExperience";

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
    <NotFoundExperience
      kind="suspended"
      standalone
      headingRef={heading}
      detail={address && (
          <p className="text-sm text-text-muted mb-2" data-testid="suspended-address">
            {address}
          </p>
      )}
      description={<>
          Its boards and data are kept, but nobody can sign in or use them until the service lifts the
          suspension. Write to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
            {CONTACT_EMAIL}
          </a>
          .
      </>}
    >
        <Button variant="secondary" onClick={() => void signOut()} disabled={leaving}>
          Sign out
        </Button>
    </NotFoundExperience>
  );
}
