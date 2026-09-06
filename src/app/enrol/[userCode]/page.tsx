"use client";

import Image from "next/image";
import { use, useCallback, useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/ui/Toast";
import { AuthGuard } from "@/components/AuthGuard";
import { Button } from "@/components/ui/Button";
import { APP_NAME } from "@/lib/brand";

interface EnrolProject {
  _id: string;
  name: string;
  key: string;
  repositoryUrl: string;
  workersEnabled: boolean;
  canEnable: boolean;
}

interface EnrolmentView {
  userCode: string;
  machineName: string;
  machineHost: string;
  status: string;
  expiresAt: string;
  projects: EnrolProject[];
  existingWorker: { mine: boolean } | null;
}

function ConsentScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-8 flex flex-col items-center">
          <Image src="/logo.svg" alt="" width={40} height={40} className="mb-3" />
          <span className="text-sm font-medium text-text-muted">{APP_NAME}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function Outcome({ title, detail }: { title: string; detail: string }) {
  return (
    <ConsentScreen>
      <div className="rounded-xl border border-border bg-bg-card p-8 text-center">
        <h1 className="text-2xl font-bold text-text">{title}</h1>
        <p className="mt-3 text-text-muted">{detail}</p>
      </div>
    </ConsentScreen>
  );
}

export default function EnrolPage({ params }: { params: Promise<{ userCode: string }> }) {
  return (
    <AuthGuard>
      <Enrol params={params} />
    </AuthGuard>
  );
}

function Enrol({ params }: { params: Promise<{ userCode: string }> }) {
  const { userCode } = use(params);
  const api = useApi();
  const { user } = useAuth();
  const { toast } = useToast();

  const [enrolment, setEnrolment] = useState<EnrolmentView | null>(null);
  const [error, setError] = useState("");
  const [projectId, setProjectId] = useState("");
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
        deny ? { deny: true } : { projectId });
      setDone(deny ? "denied" : "approved");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not complete this", "error");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <Outcome
        title="That code is no longer valid"
        detail="Enrolment codes last fifteen minutes. Start again from the app on the machine."
      />
    );
  }

  if (done === "approved") {
    return (
      <Outcome
        title="Connected"
        detail="The machine has its credential and sets up that repository next. More projects are added any time under Settings → Workers. You can close this tab."
      />
    );
  }

  if (done === "denied") {
    return <Outcome title="Refused" detail="Nothing was given to that machine. You can close this tab." />;
  }

  if (!enrolment) {
    return (
      <ConsentScreen>
        <div className="rounded-xl border border-border bg-bg-card p-8 text-center text-text-muted">
          Loading…
        </div>
      </ConsentScreen>
    );
  }

  const usable = enrolment.projects.filter((p) => p.repositoryUrl);
  const chosen = usable.find((p) => p._id === projectId);
  const willStaySwitchedOff = !!chosen && !chosen.workersEnabled && !chosen.canEnable;

  return (
    <ConsentScreen>
      <div className="rounded-xl border border-border bg-bg-card p-6 sm:p-8">
        <h1 className="text-2xl font-bold text-text">Connect this machine?</h1>
        <p className="mt-3 text-text-muted">
          A worker on <strong className="text-text">{enrolment.machineName}</strong>
          {enrolment.machineHost && ` (${enrolment.machineHost})`} is asking to run tasks for you.
        </p>
        <p className="mt-1 text-sm text-text-muted">
          Check it shows the same code:{" "}
          <code className="font-mono text-text">{enrolment.userCode}</code>
        </p>

        {enrolment.existingWorker?.mine && (
          <div
            data-testid="already-registered"
            className="mt-6 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-text"
          >
            This machine already has a worker registered. Connecting replaces its credential, which
            stops the one running there now — it will need restarting from the app.
          </div>
        )}

        {enrolment.existingWorker && !enrolment.existingWorker.mine && (
          <div
            data-testid="belongs-to-somebody-else"
            className="mt-6 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-text"
          >
            A machine with this name is already enrolled to somebody else, so connecting will be
            refused. If it is yours, ask an instance admin to release it under Settings → Workers.
          </div>
        )}

        <section className="mt-8">
          <h2 className="text-sm font-medium text-text">Which repository should it set up first?</h2>
          <p className="mt-1 text-sm text-text-muted">
            Not a limit on what it may work on — the machine acts under your account and reaches
            every project you can.
          </p>
          <div className="mt-3 space-y-2">
            {usable.length === 0 && (
              <p className="text-sm text-text-muted">
                No project names a repository yet. Set one under a project&apos;s Integrations
                settings first — a machine is told which repository to fetch.
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
                <span className="min-w-0">
                  <span className="block font-medium text-text">
                    {p.name} <span className="text-text-muted">· {p.key}</span>
                  </span>
                  <span className="block truncate font-mono text-xs text-text-muted">
                    {p.repositoryUrl}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {willStaySwitchedOff && (
          <div
            data-testid="workers-off-warning"
            className="mt-6 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-text"
          >
            That project does not run machines yet, and you cannot turn that on. The machine will
            connect and sit idle until an instance admin enables it under the project&apos;s Workers
            settings.
          </div>
        )}

        <div className="mt-8 flex gap-3">
          <Button disabled={busy || !projectId} onClick={() => decide(false)}>
            {busy ? "Connecting…" : "Connect it"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => decide(true)}>
            Refuse
          </Button>
        </div>
      </div>

      {user && (
        <p className="mt-4 text-center text-xs text-text-muted">
          Connecting as {user.fullName || user.username}. The machine acts under this account.
        </p>
      )}
    </ConsentScreen>
  );
}
