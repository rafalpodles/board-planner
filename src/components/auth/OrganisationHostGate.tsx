"use client";

import { useEffect, useState } from "react";
import { OrganisationSuspended } from "@/components/OrganisationSuspended";
import { ORGANISATION_SUSPENDED_HEADER } from "@/lib/organisation-limit-header";

type HostState = { kind: "organisation" } | { kind: "suspended" } | { kind: "none" | "platform"; signIn: string | null };

function NoOrganisationHere({ kind, signIn }: { kind: "none" | "platform"; signIn: string | null }) {
  const host = typeof window === "undefined" ? "" : window.location.host;
  return (
    <div className="flex items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-sm text-center" data-testid="no-organisation-here">
        <h1 className="text-lg font-semibold mb-2">
          {kind === "platform" ? "Sign in from the front page" : <>There is no organisation at {host}</>}
        </h1>
        <p className="text-sm text-text mb-6">
          {kind === "platform"
            ? "This address signs you in to any organisation: start with your e-mail address."
            : "Check the address you were given. If you do not remember your organisation's address, sign in with your e-mail address instead."}
        </p>
        <a
          href={kind === "platform" ? "/?switch" : signIn ? `${signIn}/?switch` : "/"}
          className="focus-ring inline-flex min-h-[44px] items-center justify-center rounded-lg bg-primary-solid px-4 py-2 text-sm font-medium text-white hover:bg-primary-solid-hover"
        >
          Sign in with your e-mail address
        </a>
      </div>
    </div>
  );
}

export function OrganisationHostGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<HostState>({ kind: "organisation" });

  useEffect(() => {
    let live = true;
    fetch("/api/auth/instance")
      .then(async (response) => {
        if (!live) return;
        if (response.status === 503 && response.headers.get(ORGANISATION_SUSPENDED_HEADER)) return setState({ kind: "suspended" });
        if (response.status !== 404) return;
        const body = await response.json().catch(() => null);
        if (live && (body?.host === "none" || body?.host === "platform")) setState({ kind: body.host, signIn: body.signIn ?? null });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (state.kind === "suspended") return <OrganisationSuspended />;
  if (state.kind === "none" || state.kind === "platform") return <NoOrganisationHere kind={state.kind} signIn={state.signIn} />;
  return <>{children}</>;
}
