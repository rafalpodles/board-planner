"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { SettingsCard } from "./SettingsCard";

export function ProjectExport({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  async function download() {
    setBusy(true);
    setFailure("");
    try {
      const response = await fetch(`/api/projects/${projectId}/export?check=1`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setFailure(body?.error ?? `The export was refused (${response.status}).`);
        return;
      }
      window.location.assign(`/api/projects/${projectId}/export`);
    } catch {
      setFailure("The export could not be started. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title="Export project"
      description={`${projectName} in one file: tasks, comments, history, sprints, agents, settings and uploaded files. Tokens, webhook addresses and sign-in secrets are left out.`}
    >
      <Button onClick={download} disabled={busy} aria-busy={busy}>
        Download the project export
      </Button>
      <p className="mt-2 text-sm text-text-muted">
        A gzip-compressed file of JSON lines, one per record. The download is written to this project&apos;s audit log.
      </p>
      {failure && (
        <div className="mt-4">
          <LoadFailed testId="project-export-error" message={failure} onRetry={download} />
        </div>
      )}
    </SettingsCard>
  );
}
