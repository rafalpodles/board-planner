"use client";

import { useAuth } from "@/hooks/use-auth";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";

const FIRST_RETRY_MS = 10_000;
const MAX_RETRY_MS = 60_000;

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading, outage, refreshUser } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !user && !outage) {
      const intended = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(intended)}`);
    }
  }, [user, isLoading, outage, router, pathname]);

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
