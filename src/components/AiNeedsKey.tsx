"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";

/**
 * Where a Free cloud organisation lands instead of an AI feature (BP-652): the two ways out, which
 * are its own key or Pro. Only an instance admin can do either, so a member is told whom to ask.
 */
export function AiNeedsKey({ what, className = "" }: { what: string; className?: string }) {
  const { isAdmin } = useAuth();

  return (
    <div role="note" data-testid="ai-needs-key" className={`rounded-lg border border-border bg-bg-input p-3 text-sm ${className}`}>
      <p className="font-medium">{what} runs on your own OpenRouter key on the Free plan.</p>
      {isAdmin ? (
        <p className="mt-1 text-text-muted">
          <Link href="/settings/ai-keys" className="underline">
            Add a key
          </Link>{" "}
          in Settings, or{" "}
          <Link href="/settings/organisation" className="underline">
            upgrade to Pro
          </Link>{" "}
          and use ours.
        </p>
      ) : (
        <p className="mt-1 text-text-muted">Ask an administrator of this organisation to add a key or upgrade to Pro.</p>
      )}
    </div>
  );
}

/** The key the organisation stored cannot be opened any more, which is not the same as having none */
export function AiKeyUnreadable({ what, className = "" }: { what: string; className?: string }) {
  const { isAdmin } = useAuth();

  return (
    <div role="note" data-testid="ai-key-unreadable" className={`rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm ${className}`}>
      <p className="font-medium">{what} cannot run: the stored AI key cannot be read.</p>
      {isAdmin ? (
        <p className="mt-1 text-text-muted">
          <Link href="/settings/ai-keys" className="underline">
            Enter it again
          </Link>{" "}
          in Settings.
        </p>
      ) : (
        <p className="mt-1 text-text-muted">Ask an administrator of this organisation to enter the key again.</p>
      )}
    </div>
  );
}
