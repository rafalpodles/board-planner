"use client";

import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { APP_NAME } from "@/lib/brand";

const link = "underline";

const changedOn = (version: string) =>
  new Date(`${version}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function TermsChangedBanner() {
  const { user, refreshUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const terms = user?.termsChanged ?? null;
  if (!terms) return null;

  async function dismiss() {
    if (!terms) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/users/me/terms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: terms.version }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await refreshUser();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const documents = (
    <>
      <a href={terms.terms} target="_blank" rel="noopener noreferrer" className={link}>
        Terms of Service
      </a>{" "}
      and{" "}
      <a href={terms.privacy} target="_blank" rel="noopener noreferrer" className={link}>
        Privacy Policy
      </a>
    </>
  );

  return (
    <div className="flex items-start gap-2 border-b border-border bg-primary/10 px-4 py-2 text-sm text-text" data-testid="terms-changed">
      <div className="min-w-0 flex-1 text-center">
        <p data-testid="terms-changed-message">
          {user?.termsAcceptedVersion ? (
            <>
              The {documents} changed on <span className="whitespace-nowrap">{changedOn(terms.version)}</span>.
            </>
          ) : (
            <>
              {APP_NAME}&apos;s {documents} apply to your use of it.
            </>
          )}{" "}
          <a href={terms.terms} target="_blank" rel="noopener noreferrer" className={link}>
            Read them
          </a>{" "}
          (
          <a href={terms.termsPl} target="_blank" rel="noopener noreferrer" lang="pl" className={link}>
            Polski
          </a>
          ).
        </p>
        {failed && (
          <p role="alert" className="text-danger" data-testid="terms-changed-error">
            Could not hide this notice. Try again.
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => void dismiss()}
        disabled={busy}
        aria-label="Dismiss the notice of the terms"
        className="focus-ring -my-1 flex min-h-[32px] min-w-[32px] shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-50"
      >
        &#x2715;
      </button>
    </div>
  );
}
