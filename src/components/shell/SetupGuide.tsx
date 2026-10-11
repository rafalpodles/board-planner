"use client";

import { useState } from "react";
import Link from "next/link";
import type { ApiSetupGuide, ApiSetupGuideStep, SetupGuideGroupId } from "@/types";
import { GROUP_TITLES, STEP_COPY } from "./setup-guide-copy";

function progress(guide: ApiSetupGuide) {
  const total = guide.steps.length;
  const done = guide.steps.filter((s) => s.done).length;
  const next = guide.steps.find((s) => !s.done) ?? null;
  return { total, done, next };
}

function Ring({ done, total, size }: { done: number; total: number; size: number }) {
  const radius = size / 2 - 4;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={3.5} className="stroke-border" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={3.5}
          strokeLinecap="round"
          className="stroke-primary transition-[stroke-dashoffset]"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - done / total)}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold">{done}</span>
    </span>
  );
}

export function SetupGuideCard({
  guide,
  compact,
  onOpen,
}: {
  guide: ApiSetupGuide;
  compact: boolean;
  onOpen: () => void;
}) {
  const { done, total, next } = progress(guide);
  const label = `Setup guide, ${done} of ${total} done${next ? `. Next: ${STEP_COPY[next.id].title}` : ""}`;
  if (compact) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={label}
        aria-label={label}
        data-testid="setup-guide-card"
        className="focus-ring mx-auto mb-2 flex rounded-full"
      >
        <Ring done={done} total={total} size={34} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="setup-guide-card"
      className="focus-ring mx-2.5 mb-2 block rounded-xl border border-border bg-bg-card p-3 text-left transition-colors hover:border-primary/50"
    >
      <span className="flex items-center gap-2.5">
        <Ring done={done} total={total} size={38} />
        <span className="min-w-0">
          <span className="block text-[13px] font-medium">Setup guide</span>
          <span className="block text-xs text-text-muted" data-testid="setup-guide-count">
            {done} of {total} done
          </span>
        </span>
      </span>
      {next && (
        <span className="mt-2 block truncate border-t border-border pt-2 text-xs">
          <span className="text-text-muted">Next </span>
          <span className="font-medium">{STEP_COPY[next.id].title}</span>
        </span>
      )}
    </button>
  );
}

function StepAction({ step, projectRef }: { step: ApiSetupGuideStep; projectRef: string }) {
  const copy = STEP_COPY[step.id];
  const className =
    "focus-ring inline-flex min-h-[44px] items-center rounded-md bg-primary-solid px-2.5 text-xs font-semibold text-white hover:bg-primary-solid-hover md:min-h-0 md:py-1";
  if (step.locked) {
    return <p className="mt-1 text-xs text-text-muted">An instance admin has locked agent runs off for this board.</p>;
  }
  return copy.external ? (
    <a href={copy.href(projectRef)} target="_blank" rel="noopener noreferrer" className={className}>
      {copy.action}
    </a>
  ) : (
    <Link href={copy.href(projectRef)} className={className}>
      {copy.action}
    </Link>
  );
}

export function SetupGuidePanel({
  guide,
  projectRef,
  onClose,
  onHide,
}: {
  guide: ApiSetupGuide;
  projectRef: string;
  onClose: () => void;
  onHide: () => void;
}) {
  const { done, total, next } = progress(guide);
  const groups = [...new Set(guide.steps.map((s) => s.group))] as SetupGuideGroupId[];
  const [open, setOpen] = useState<SetupGuideGroupId | null>(next?.group ?? groups[0] ?? null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const left = total - done;

  return (
    <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-2.5 pb-3 [&>*]:shrink-0" data-testid="setup-guide-panel">
      <button
        type="button"
        onClick={onClose}
        data-testid="setup-guide-close"
        className="focus-ring flex min-h-[44px] items-center gap-1 self-start rounded px-1 text-xs text-text-muted hover:text-text md:min-h-0"
      >
        <span aria-hidden="true">←</span> Back to projects
      </button>
      <div className="flex items-center gap-3 px-1 pb-2">
        <Ring done={done} total={total} size={44} />
        <div>
          <h2 className="text-[15px] font-medium">Setup guide</h2>
          <p className="text-xs text-text-muted">{left === 1 ? "1 step left" : `${left} steps left`}</p>
        </div>
      </div>

      {next && (
        <div className="mb-1 rounded-lg bg-primary/10 p-3" data-testid="setup-guide-next">
          <p className="text-[11px] text-primary-on-tint">Do this next</p>
          <p className="my-0.5 text-[13px] font-medium text-primary-on-tint">{STEP_COPY[next.id].title}</p>
          <p className="mb-2 text-xs text-primary-on-tint">{STEP_COPY[next.id].why}</p>
          <StepAction step={next} projectRef={projectRef} />
        </div>
      )}

      {groups.map((group) => {
        const steps = guide.steps.filter((s) => s.group === group);
        const isOpen = open === group;
        return (
          <div key={group} className="border-t border-border py-0.5" data-testid="setup-guide-group" data-group={group}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : group)}
              className="focus-ring flex min-h-[44px] w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-bg-hover md:min-h-0 md:py-2"
            >
              <span className="text-[13px] font-medium">{GROUP_TITLES[group]}</span>
              <span className="ml-auto text-[11px] text-text-muted">
                {steps.filter((s) => s.done).length}/{steps.length}
              </span>
              <span aria-hidden="true" className="text-text-muted">
                {isOpen ? "▴" : "▾"}
              </span>
            </button>
            {isOpen && (
              <ul>
                {steps.map((step) => {
                  const copy = STEP_COPY[step.id];
                  const isExpanded = expanded === step.id && !step.done;
                  return (
                    <li key={step.id} data-testid="setup-guide-step" data-step={step.id} data-done={step.done}>
                      <button
                        type="button"
                        onClick={() => setExpanded(isExpanded ? null : step.id)}
                        aria-expanded={step.done ? undefined : isExpanded}
                        className="focus-ring flex min-h-[44px] w-full items-start gap-2 rounded-md py-1.5 pl-2.5 pr-1.5 text-left hover:bg-bg-hover md:min-h-0"
                      >
                        <span
                          aria-hidden="true"
                          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                            step.done ? "bg-success/15 text-success" : "border border-border"
                          }`}
                        >
                          {step.done ? "✓" : ""}
                        </span>
                        <span className={`text-[13px] ${step.done ? "text-text-muted line-through" : ""}`}>
                          {copy.title}
                          <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
                        </span>
                      </button>
                      {isExpanded && (
                        <div className="pb-2 pl-9 pr-2">
                          <p className="mb-1.5 text-xs text-text-muted">{copy.why}</p>
                          <StepAction step={step} projectRef={projectRef} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}

      <p className="px-1.5 pt-2 text-[11px] text-text-muted">
        Steps tick themselves when you do them.{" "}
        <button type="button" onClick={onHide} data-testid="setup-guide-hide" className="focus-ring rounded text-primary hover:underline">
          Hide guide
        </button>
      </p>
    </div>
  );
}
