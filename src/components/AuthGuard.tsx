"use client";

import { useAuth } from "@/hooks/use-auth";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  // usePathname only to re-run on navigation; the destination itself comes from window below.
  // useSearchParams here would opt every page under this layout out of static prerendering.
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !user) {
      // Carry where they were going. Arriving from another application — the menubar app opens the
      // approval page — this is the difference between signing in and being dropped on the board
      // with no idea what happened to the link they clicked.
      const intended = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(intended)}`);
    }
  }, [user, isLoading, router, pathname]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!user) return null;

  return <>{children}</>;
}
