"use client";

import { useAuth } from "@/hooks/use-auth";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";

// Backed off rather than a fixed interval: /api/auth/me can take seconds to fail during an outage,
// and a fixed 10 s left three requests in flight at once on a tab nobody was watching
const FIRST_RETRY_MS = 10_000;
const MAX_RETRY_MS = 60_000;

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading, outage, refreshUser } = useAuth();
  const router = useRouter();
  // usePathname only to re-run on navigation; the destination itself comes from window below.
  // useSearchParams here would opt every page under this layout out of static prerendering.
  const pathname = usePathname();

  useEffect(() => {
    // `outage` means the server never answered the question, so there is nothing here to act on.
    // Redirecting anyway sent people to a sign-in page that could not sign them in either (BP-362).
    if (!isLoading && !user && !outage) {
      // Carry where they were going. Arriving from another application — the menubar app opens the
      // approval page — this is the difference between signing in and being dropped on the board
      // with no idea what happened to the link they clicked.
      const intended = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(intended)}`);
    }
  }, [user, isLoading, outage, router, pathname]);

  // The session cookie is untouched, so the app can come back by itself rather than waiting for
  // somebody to reload a page that looks broken. Chained after each attempt settles, so a slow
  // request never overlaps the next one.
  const retryDelay = useRef(FIRST_RETRY_MS);
  useEffect(() => {
    if (!outage || user) {
      retryDelay.current = FIRST_RETRY_MS;
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const attempt = () => {
      timer = setTimeout(async () => {
        await refreshUser();
        if (stopped) return;
        retryDelay.current = Math.min(retryDelay.current * 2, MAX_RETRY_MS);
        attempt();
      }, retryDelay.current);
    };
    attempt();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [outage, user, refreshUser]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div
          role="status"
          aria-label="Loading"
          className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent"
        />
      </div>
    );
  }

  if (!user && outage) {
    return (
      <div className="flex items-center justify-center min-h-screen px-4">
        <div role="status" className="w-full max-w-sm text-center">
          <h1 className="text-lg font-semibold mb-2">This instance is having trouble</h1>
          <p className="text-sm text-text mb-6">
            It cannot reach its database, or is restarting, so it cannot tell who you are. You have
            not been signed out — this page will keep trying, and come back on its own.
          </p>
          <Button variant="secondary" onClick={() => void refreshUser()}>
            Try again now
          </Button>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <>
      {/* Somebody already signed in is never sent back through /api/auth/me, so without this the
          instance going down showed up only as every screen failing to load for its own reasons */}
      {outage && (
        <div
          role="status"
          className="px-4 py-2 text-center text-sm bg-warning/15 text-text border-b border-border"
        >
          This instance is having trouble reaching its database. You are still signed in; what you
          are looking at may be out of date.
        </div>
      )}
      {children}
    </>
  );
}
