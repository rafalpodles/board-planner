"use client";

import { useAuth } from "@/hooks/use-auth";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/Button";

const RETRY_INTERVAL_MS = 10_000;

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
  // somebody to reload a page that looks broken
  useEffect(() => {
    if (!outage || user) return;
    const timer = setInterval(() => void refreshUser(), RETRY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [outage, user, refreshUser]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!user && outage) {
    return (
      <div className="flex items-center justify-center min-h-screen px-4">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-lg font-semibold mb-2">This instance is having trouble</h1>
          <p className="text-sm text-text-muted mb-6">
            It cannot reach its database, so it cannot tell who you are. You have not been signed
            out — this page will keep trying, and come back on its own.
          </p>
          <Button variant="secondary" onClick={() => void refreshUser()}>
            Try again now
          </Button>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return <>{children}</>;
}
