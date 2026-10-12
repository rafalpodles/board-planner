"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LoadFailed } from "@/components/ui/LoadFailed";

/** A failed host lookup says nothing about whether an organisation exists. */
export function HostUnavailable() {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <LoadFailed
        message="Board Planner is having trouble reaching its database. Please try again."
        busy={busy}
        onRetry={() => startTransition(() => router.refresh())}
      />
    </main>
  );
}
