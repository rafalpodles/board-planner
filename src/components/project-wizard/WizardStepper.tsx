"use client";

import { STEPS } from "./wizard-model";

interface WizardStepperProps {
  current: number;
  /** A later step is closed until the basics are valid */
  isOpen: (index: number) => boolean;
  onGo: (index: number) => void;
}

export function WizardStepper({ current, isOpen, onGo }: WizardStepperProps) {
  return (
    <nav aria-label="Setup steps">
      <ol className="hidden sm:flex">
        {STEPS.map((step, i) => {
          const state = i < current ? "done" : i === current ? "current" : "todo";
          return (
            <li key={step.id} className="min-w-0 flex-1">
              <button
                type="button"
                disabled={!isOpen(i)}
                aria-current={i === current ? "step" : undefined}
                onClick={() => onGo(i)}
                className={`focus-ring relative flex w-full flex-col items-center gap-1.5 px-0.5 py-1 text-xs disabled:cursor-not-allowed ${
                  i === current ? "font-semibold text-text" : "text-text-muted"
                }`}
              >
                {i > 0 && (
                  <span
                    aria-hidden="true"
                    className={`absolute right-1/2 top-[18px] h-0.5 w-full ${
                      i <= current ? "bg-primary-solid" : "bg-border"
                    }`}
                  />
                )}
                <span
                  aria-hidden="true"
                  className={`relative z-10 grid h-7 w-7 place-items-center rounded-full border text-[13px] font-semibold ${
                    state === "done"
                      ? "border-primary-solid bg-primary-solid text-white"
                      : state === "current"
                        ? "border-primary bg-bg-card text-primary ring-[3px] ring-primary/20"
                        : "border-border bg-bg-card"
                  }`}
                >
                  {state === "done" ? "✓" : i + 1}
                </span>
                <span>{step.title}</span>
                <span className="-mt-1 text-[10.5px] font-normal text-text-muted">
                  {step.optional ? "optional" : " "}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="sm:hidden">
        <p className="mb-2 flex items-baseline justify-between gap-2 px-1">
          <b className="text-sm">{STEPS[current].title}</b>
          <span className="text-xs text-text-muted">
            Step {current + 1} of {STEPS.length}
          </span>
        </p>
        <div aria-hidden="true" className="grid grid-cols-5 gap-1">
          {STEPS.map((step, i) => (
            <i
              key={step.id}
              className={`h-1 rounded-sm ${i <= current ? "bg-primary-solid" : "bg-border"}`}
            />
          ))}
        </div>
      </div>
    </nav>
  );
}
