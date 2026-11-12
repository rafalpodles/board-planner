"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { agentSetupComplete, type SetupStep, type SetupStepKey } from "@/lib/agent-setup";
import { taskPath } from "@/lib/urls";
import { APP_NAME } from "@/lib/brand";
import type { ApiAgentSetup } from "@/types";

const POLL_MS = 3000;
const SINCE_KEY = "agent-setup-since";

const TITLES: Record<SetupStepKey, string> = {
  agent: "Your coding agent connected",
  board: "Board created from your repository",
  gates: "Gates chosen with you",
  machine: "This Mac connected",
  task: "First task ready",
};

function readSince(): string | null {
  try {
    return sessionStorage.getItem(SINCE_KEY);
  } catch {
    return null;
  }
}

function keepSince(since: string) {
  try {
    sessionStorage.setItem(SINCE_KEY, since);
  } catch {
    /* a private window keeps nothing; the screen still works for this visit */
  }
}

export default function AgentSetupPage() {
  return (
    <AuthGuard>
      <AgentSetup />
    </AuthGuard>
  );
}

function AgentSetup() {
  const api = useApi();
  const { user } = useAuth();
  const { toast } = useToast();
  const router = useRouter();
  const [setup, setSetup] = useState<ApiAgentSetup | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState(false);
  const since = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const query = since.current ? `?since=${encodeURIComponent(since.current)}` : "";
      const next: ApiAgentSetup = await api.get(`/api/onboarding/agent-setup${query}`);
      if (!since.current) {
        since.current = next.since;
        keepSince(next.since);
      }
      setSetup(next);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the setup");
    }
  }, [api]);

  useEffect(() => {
    since.current = readSince();
    load();
  }, [load]);

  const complete = setup ? agentSetupComplete(setup.steps) : false;
  useEffect(() => {
    if (complete) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [complete, load]);

  async function copy() {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.prompt);
      setCopied(true);
    } catch {
      toast("Could not copy. Select the prompt and copy it instead.", "error");
    }
  }

  async function run() {
    const target = setup?.run;
    if (!target || !user) return;
    if (!target.status) {
      toast("This board has no column for approved work, so nothing would take the task.", "error");
      return;
    }
    setRunning(true);
    try {
      await api.put(`/api/projects/${target.projectId}/tasks/${target.taskId}`, {
        agent: target.agentId,
        assignee: user.username,
        status: target.status,
      });
      router.push(taskPath(target.projectKey, target.taskNumber));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not hand the task over", "error");
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-8 flex items-center gap-2">
        <Image src="/logo.svg" alt="" width={24} height={24} />
        <span className="text-sm font-semibold text-text">{APP_NAME}</span>
      </div>
      <h1 className="text-2xl font-bold text-text">Let your coding agent set this up</h1>
      <p className="mt-2 max-w-3xl text-sm text-text-muted">
        Open your coding agent in the repository you want on a board, and paste this prompt. It installs the Board
        Planner skill, creates the board and connects this Mac. You watch it here.
      </p>

      {error && (
        <p role="alert" className="mt-6 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <section className="min-w-0 rounded-xl border border-border bg-bg-card p-5" aria-labelledby="prompt-title">
          <div className="flex items-center gap-3">
            <h2 id="prompt-title" className="flex-1 text-base font-semibold text-text">
              Paste into your coding agent
            </h2>
            <Button onClick={copy} disabled={!setup} data-testid="copy-prompt">
              {copied ? "Copied" : "Copy prompt"}
            </Button>
          </div>
          <pre
            data-testid="setup-prompt"
            className="mt-4 whitespace-pre-wrap break-words rounded-lg border border-border bg-bg p-4 font-mono text-xs leading-relaxed text-text"
          >
            {setup?.prompt ?? "Loading…"}
          </pre>
          <p className="mt-3 text-xs text-text-muted">
            The approval of this Mac stays yours: the agent prints a link, and you approve it in the browser.{" "}
            <Link href="/projects/new" className="text-primary hover:underline">
              Set it up by hand instead
            </Link>
          </p>
        </section>

        <section
          className="min-w-0 self-start rounded-xl border border-border bg-bg-card p-5"
          aria-labelledby="progress-title"
          aria-live="polite"
        >
          <h2 id="progress-title" className="text-base font-semibold text-text">
            What your agent has done
          </h2>
          <ol className="mt-3">
            {(setup?.steps ?? []).map((step) => (
              <StepRow key={step.key} step={step} />
            ))}
          </ol>
          {setup?.run && complete && (
            <Button className="mt-4 w-full" size="lg" onClick={run} disabled={running} data-testid="run-first-task">
              {running ? "Handing it over…" : `Run ${setup.run.projectKey}-${setup.run.taskNumber}`}
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: SetupStep }) {
  return (
    <li className="flex items-start gap-3 border-t border-border py-3 first:border-t-0" data-testid={`setup-step-${step.key}`} data-state={step.state}>
      <span aria-hidden className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs">
        {step.state === "done" ? (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-success/15 text-success">✓</span>
        ) : step.state === "waiting" ? (
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
        ) : (
          <span className="h-5 w-5 rounded-full border border-dashed border-border" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm ${step.state === "todo" ? "text-text-muted" : "text-text"}`}>
          {TITLES[step.key]}
          <span className="sr-only">: {step.state === "done" ? "done" : step.state === "waiting" ? "in progress" : "not yet"}</span>
        </span>
        {step.detail && (
          <span className={`block break-words text-xs ${step.state === "waiting" ? "text-primary" : "text-text-muted"}`}>
            {step.detail}
          </span>
        )}
      </span>
    </li>
  );
}
