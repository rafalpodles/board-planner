"use client";

import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { IconPicker } from "@/components/ui/IconPicker";
import { PROJECT_KEY_MAX_LENGTH } from "@/lib/identifiers";
import type { WizardState } from "./wizard-model";

interface BasicsStepProps {
  state: WizardState;
  /** Why Next is not available, once there is something typed to be wrong */
  problem: string | null;
  onName: (name: string) => void;
  onKey: (key: string) => void;
  onChange: (patch: Partial<WizardState>) => void;
}

export function BasicsStep({ state, problem, onName, onKey, onChange }: BasicsStepProps) {
  const shown = problem !== null && (state.name.trim() !== "" || state.key !== "");

  return (
    <>
      <Input
        label="Project Name"
        value={state.name}
        onChange={(e) => onName(e.target.value)}
        placeholder="My Project"
        autoComplete="off"
        data-submit-on-enter
        required
      />
      <div>
        <Input
          label="Project Key"
          value={state.key}
          onChange={(e) => onKey(e.target.value)}
          placeholder="MP"
          maxLength={PROJECT_KEY_MAX_LENGTH}
          aria-describedby={shown ? "project-key-hint project-key-problem" : "project-key-hint"}
          aria-invalid={shown || undefined}
          autoComplete="off"
          data-submit-on-enter
          required
        />
        <p id="project-key-hint" className="mt-1 text-xs text-text-muted">
          Task keys are built from it ({state.key || "MP"}-1, {state.key || "MP"}-2…) and it cannot
          change later.
        </p>
        {shown && (
          <p id="project-key-problem" role="status" className="mt-1 text-sm text-danger">
            {problem}
          </p>
        )}
      </div>
      <div>
        <span className="mb-1 block text-sm font-medium text-text-muted">Icon</span>
        <IconPicker
          label="Choose project icon"
          value={state.icon}
          onChange={(icon) => onChange({ icon })}
        />
      </div>
      <Textarea
        label="Description"
        value={state.description}
        onChange={(e) => onChange({ description: e.target.value })}
        placeholder="What is this project about?"
      />
    </>
  );
}
