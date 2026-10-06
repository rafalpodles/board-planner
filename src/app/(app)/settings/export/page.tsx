"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/Button";
import { LoadFailed } from "@/components/ui/LoadFailed";

const FILENAME = /filename="([^"]+)"/;

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
      const response = await fetch("/api/admin/export");
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setFailure(body?.error ?? `The export was refused (${response.status}).`);
        return;
      }
      const blob = await response.blob();
      const name = FILENAME.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "organisation-export.ndjson.gz";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setFailure("The export could not be downloaded. Check your connection and try again.");
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
        {busy ? "Preparing the export…" : "Download the export"}
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
