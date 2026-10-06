"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/Button";
import { LoadFailed } from "@/components/ui/LoadFailed";

export default function ExportSettingsPage() {
  const router = useRouter();
  const { isAdmin, isLoading: authLoading } = useAuth();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    if (!authLoading && !isAdmin) router.replace("/projects");
  }, [isAdmin, authLoading, router]);

  async function download() {
    setBusy(true);
    setFailure("");
    try {
      const response = await fetch("/api/admin/export?check=1");
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setFailure(body?.error ?? `The export was refused (${response.status}).`);
        return;
      }
      window.location.assign("/api/admin/export");
    } catch {
      setFailure("The export could not be started. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || !isAdmin) return null;

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">Export</h2>
      <p className="text-sm text-text-muted mb-6">
        Everything this organisation holds, in one file: boards, tasks, comments, people, settings and
        uploaded files. Passwords, sign-in tokens and links still in flight are left out.
      </p>
      <Button onClick={download} disabled={busy} aria-busy={busy}>
        Download the export
      </Button>
      <p className="mt-2 text-sm text-text-muted">
        A gzip-compressed file of JSON lines, one per record. A large organisation takes a while. The download
        is written to the audit log.
      </p>
      {failure && (
        <div className="mt-4">
          <LoadFailed testId="export-error" message={failure} onRetry={download} />
        </div>
      )}
    </div>
  );
}
