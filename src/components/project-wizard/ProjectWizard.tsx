"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useProjects } from "@/hooks/use-projects";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/shell/PageHeader";
import { PROJECT_KEY_MAX_LENGTH, suggestProjectKey } from "@/lib/identifiers";
import { projectPath } from "@/lib/urls";
import { AccessStep, type PmAvailability } from "./AccessStep";
import { BasicsStep } from "./BasicsStep";
import { FieldsStep } from "./FieldsStep";
import { ReviewStep } from "./ReviewStep";
import { WizardStepper } from "./WizardStepper";
import { WorkflowStep } from "./WorkflowStep";
import {
  STEPS,
  basicsProblem,
  buildPayload,
  initialState,
  workflowProblem,
  type WizardState,
} from "./wizard-model";

const LAST = STEPS.length - 1;

export function ProjectWizard() {
  const api = useApi();
  const router = useRouter();
  const { user } = useAuth();
  const { projects, reload } = useProjects();
  const takenKeys = projects.map((p) => p.key);
  const takenSignature = takenKeys.join(",");

  const [state, setState] = useState<WizardState>(initialState);
  const [step, setStep] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [pm, setPm] = useState<PmAvailability | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const arrived = useRef(false);

  const change = useCallback((patch: Partial<WizardState>) => {
    setState((s) => ({ ...s, ...patch }));
  }, []);

  // The board list can arrive after the name was typed; a suggestion made without it could be taken
  useEffect(() => {
    setState((s) =>
      s.keyTyped ? s : { ...s, key: suggestProjectKey(s.name, takenSignature ? takenSignature.split(",") : []) }
    );
  }, [takenSignature]);

  useEffect(() => {
    let live = true;
    api
      .get("/api/projects/setup")
      .then((answer) => live && setPm(answer as PmAvailability))
      .catch(() => live && setPm(null));
    return () => {
      live = false;
    };
  }, [api]);

  // A new step starts at its heading, for a keyboard or a screen reader that just pressed Next
  useEffect(() => {
    if (!arrived.current) {
      arrived.current = true;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const onName = (name: string) =>
    setState((s) => ({
      ...s,
      name,
      key: s.keyTyped ? s.key : suggestProjectKey(name, takenKeys),
    }));
  const onKey = (raw: string) =>
    setState((s) => ({ ...s, key: raw.toUpperCase().slice(0, PROJECT_KEY_MAX_LENGTH), keyTyped: raw !== "" }));

  const basics = basicsProblem(state, takenKeys);
  const workflow = workflowProblem(state);
  const blocking = basics ?? workflow;
  const youName = user?.fullName || user?.username || "You";

  const isOpen = (index: number) => index === 0 || basics === null;
  const go = (index: number) => {
    if (!isOpen(index)) return;
    setError("");
    setStep(index);
  };
  const canAdvance = step === 0 ? basics === null : step === 1 ? workflow === null : true;

  async function create() {
    if (creating || blocking) return;
    setCreating(true);
    setError("");
    try {
      const project = await api.post("/api/projects", buildPayload(state));
      await reload();
      router.push(projectPath(project.key));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (step === LAST) void create();
    else if (canAdvance) go(step + 1);
  }

  const current = STEPS[step];
  const nextTitle = step < LAST ? STEPS[step + 1].title : "";

  return (
    <div className="mx-auto w-full max-w-[720px]">
      <PageHeader title="New project" subtitle={`Step ${step + 1} of ${STEPS.length} · ${current.title}`} />

      <form onSubmit={onSubmit} className="flex flex-col gap-4 pb-2">
        <WizardStepper current={step} isOpen={isOpen} onGo={go} />

        <section className="flex min-w-0 flex-col rounded-xl border border-border bg-bg-card">
          <header className="border-b border-border px-4 py-3">
            <h2 ref={heading} tabIndex={-1} className="text-[15px] font-semibold">
              {current.title}
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">{current.description}</p>
          </header>

          <div className="flex min-w-0 flex-col gap-4 p-4">
            {step === 0 && (
              <BasicsStep
                state={state}
                takenKeys={takenKeys}
                onName={onName}
                onKey={onKey}
                onChange={change}
              />
            )}
            {step === 1 && <WorkflowStep state={state} onChange={change} />}
            {step === 2 && <FieldsStep state={state} onChange={change} />}
            {step === 3 && <AccessStep state={state} you={youName} pm={pm} onChange={change} />}
            {step === LAST && (
              <>
                {blocking && (
                  <p role="alert" className="text-sm text-danger">
                    {blocking}
                  </p>
                )}
                <ReviewStep state={state} you={youName} error={error} onEdit={go} />
              </>
            )}
          </div>

          <footer
            data-pinned-bottom-bar
            className="sticky bottom-0 z-10 flex items-center gap-2 rounded-b-xl border-t border-border bg-bg-card px-4 py-3"
          >
            {step === 0 ? (
              <Button type="button" variant="secondary" onClick={() => router.back()} className="max-sm:flex-1">
                Cancel
              </Button>
            ) : (
              <Button type="button" variant="secondary" onClick={() => go(step - 1)} className="max-sm:flex-1">
                Back
              </Button>
            )}
            <span className="flex-1 max-sm:hidden" />
            {step === LAST ? (
              <Button type="submit" disabled={creating || blocking !== null} className="max-sm:flex-1">
                {creating ? "Creating..." : "Create Project"}
              </Button>
            ) : (
              <>
                {current.optional && (
                  <Button type="button" variant="ghost" onClick={() => go(step + 1)} className="max-sm:flex-1">
                    Skip
                  </Button>
                )}
                <Button type="submit" disabled={!canAdvance} className="max-sm:flex-1">
                  Next: {nextTitle}
                </Button>
              </>
            )}
          </footer>
        </section>
      </form>
    </div>
  );
}
