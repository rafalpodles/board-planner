"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/shell/PageHeader";
import { WorkerPreset } from "@/types";

interface EnrolProject {
  _id: string;
  name: string;
  key: string;
  repositoryUrl: string;
  workersEnabled: boolean;
}

interface EnrolmentView {
  userCode: string;
  machineName: string;
  machineHost: string;
  status: string;
  expiresAt: string;
  projects: EnrolProject[];
  existingWorker: { _id: string; name: string; host: string; lastSeenAt: string | null } | null;
}

// Worded as autonomy, not as a gate checklist. A page that configures ten things is a settings
// screen wearing an approval's clothes, and people click through those without reading.
const PRESETS: { id: WorkerPreset; title: string; detail: string }[] = [
  {
    id: "write",
    title: "Write code",
    detail: "Runs the checks, the build and the tests, then opens a pull request. No second model reads the diff.",
  },
  {
    id: "review",
    title: "Write and review",
    detail: "As above, plus a second model that reads the diff with no memory of writing it.",
  },
  {
    id: "merge",
    title: "Write, review and merge",
    detail: "As above, and it merges its own pull request once everything passes.",
  },
];

export default function EnrolPage({ params }: { params: Promise<{ userCode: string }> }) {
  const { userCode } = use(params);
  const api = useApi();
  const { toast } = useToast();

  const [enrolment, setEnrolment] = useState<EnrolmentView | null>(null);
  const [error, setError] = useState("");
  const [projectId, setProjectId] = useState("");
  const [preset, setPreset] = useState<WorkerPreset>("review");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);

  const load = useCallback(async () => {
    try {
      setEnrolment(await api.get(`/api/workers/enrolment/device/${userCode}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "This code is not valid any more");
    }
  }, [api, userCode]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(deny: boolean) {
    setBusy(true);
    try {
      await api.post(`/api/workers/enrolment/device/${userCode}/approve`,
        deny ? { deny: true } : { projectId, preset });
      setDone(deny ? "denied" : "approved");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not complete this", "error");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <>
        <PageHeader title="Connect a machine" />
        <div className="mx-auto max-w-xl px-4 py-16 text-center">
          <p className="text-lg font-medium text-text">That code is no longer valid</p>
          <p className="mt-3 text-text-muted">
            Enrolment codes last fifteen minutes. Start again from the app on the machine.
          </p>
        </div>
      </>
    );
  }

  if (done) {
    return (
      <>
        <PageHeader title={done === "approved" ? "Connected" : "Refused"} />
        <div className="mx-auto max-w-xl px-4 py-16 text-center">
          <p className="text-text-muted">
            {done === "approved"
              ? "The machine has its credential. You can close this tab."
              : "Nothing was given to that machine. You can close this tab."}
          </p>
        </div>
      </>
    );
  }

  if (!enrolment) {
    return (
      <>
        <PageHeader title="Connect a machine" />
        <div className="mx-auto max-w-xl px-4 py-16 text-text-muted">Loading…</div>
      </>
    );
  }

  const usable = enrolment.projects.filter((p) => p.repositoryUrl);

  return (
    <>
      <PageHeader title="Connect this machine?" subtitle={enrolment.machineName} />
      <div className="mx-auto max-w-2xl px-4 py-10">
      <p className="text-text-muted">
        A worker on <strong className="text-text">{enrolment.machineName}</strong>
        {enrolment.machineHost && ` (${enrolment.machineHost})`} is asking to run tasks for you.
      </p>
      <p className="mt-1 text-sm text-text-muted">
        Check it shows the same code: <code className="font-mono text-text">{enrolment.userCode}</code>
      </p>

      {enrolment.existingWorker && (
        <div className="mt-6 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-text">
          This machine already has a worker registered. Approving replaces its credential, which
          stops the one running there now — it will need restarting from the app.
        </div>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-medium text-text">Which project should it work on?</h2>
        <div className="mt-3 space-y-2">
          {usable.length === 0 && (
            <p className="text-sm text-text-muted">
              No project names a repository yet. Set one under a project&apos;s Integrations settings
              first — a machine is told which repository to fetch.
            </p>
          )}
          {usable.map((p) => (
            <label
              key={p._id}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:border-primary"
            >
              <input
                type="radio"
                name="project"
                className="mt-1"
                checked={projectId === p._id}
                onChange={() => setProjectId(p._id)}
              />
              <span>
                <span className="block font-medium text-text">
                  {p.name} <span className="text-text-muted">· {p.key}</span>
                </span>
                <span className="block font-mono text-xs text-text-muted">{p.repositoryUrl}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium text-text">How much should it do on its own?</h2>
        <div className="mt-3 space-y-2">
          {PRESETS.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:border-primary"
            >
              <input
                type="radio"
                name="preset"
                className="mt-1"
                checked={preset === option.id}
                onChange={() => setPreset(option.id)}
              />
              <span>
                <span className="block font-medium text-text">{option.title}</span>
                <span className="block text-sm text-text-muted">{option.detail}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-text-muted">
          You can change this later in the project&apos;s Workers settings.
        </p>
      </section>

      <div className="mt-8 flex gap-3">
        <Button disabled={busy || !projectId} onClick={() => decide(false)}>
          {busy ? "Connecting…" : "Connect it"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => decide(true)}>
          Refuse
        </Button>
      </div>
      </div>
    </>
  );
}
