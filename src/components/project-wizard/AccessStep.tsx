"use client";

import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { repositoryProvider } from "@/lib/repository";
import type { GrantRelation } from "@/types";
import { PeoplePicker } from "./PeoplePicker";
import type { Person, WizardState } from "./wizard-model";

export interface WizardSetup {
  pmAvailable: boolean;
  pmNeedsPlan: boolean;
  pmKeyUnreadable: boolean;
  pmLocked: boolean;
  githubWebBase?: string;
}

/** What the instance said about the things a board does not exist yet to say */
export type SetupRead = { state: "loading" } | { state: "failed" } | { state: "ready"; setup: WizardSetup };

interface AccessStepProps {
  state: WizardState;
  you: string;
  setup: SetupRead;
  onChange: (patch: Partial<WizardState>) => void;
}

function pmUnavailable(pm: WizardSetup): string {
  if (pm.pmLocked) return "An administrator has locked the PM agent off for this instance.";
  if (pm.pmKeyUnreadable) return "The stored AI key cannot be read. Fix it in Settings → Agents.";
  if (pm.pmNeedsPlan) return "The PM agent needs a plan with managed AI, or your own key in Settings → Agents.";
  return "The PM agent needs a model key. Add one in Settings → Agents, then turn it on in the project's PM agent settings.";
}

export function AccessStep({ state, you, setup, onChange }: AccessStepProps) {
  const url = state.repositoryUrl.trim();
  const githubBase = setup.state === "ready" ? setup.setup.githubWebBase : undefined;
  const provider = url ? repositoryProvider({ repositoryUrl: url }, githubBase ?? "https://github.com") : "";

  function addPerson(person: Person) {
    if (state.people.some((p) => p.person._id === person._id)) return;
    onChange({ people: [...state.people, { person, relation: "member" }] });
  }
  function setRelation(personId: string, relation: GrantRelation) {
    onChange({
      people: state.people.map((p) => (p.person._id === personId ? { ...p, relation } : p)),
    });
  }

  return (
    <>
      <div>
        <Input
          label="Repository URL"
          value={state.repositoryUrl}
          onChange={(e) => onChange({ repositoryUrl: e.target.value })}
          placeholder="https://github.com/owner/repo"
          aria-describedby="wizard-repo-hint"
          autoComplete="off"
        />
        <p id="wizard-repo-hint" className="mt-1 text-xs text-text-muted">
          Optional. Paste the address you would clone from. Pull requests are matched by task key; add
          the access token afterwards in Settings → Integrations.
          {provider === "github" && " Recognised as GitHub."}
          {provider === "gitlab" && " Recognised as GitLab."}
        </p>
      </div>

      {setup.state !== "ready" ? (
        <div>
          <span className="block text-[13.5px] font-medium">PM agent</span>
          <p role="status" className="mt-0.5 text-xs text-text-muted">
            {setup.state === "loading"
              ? "Checking whether the PM agent can run on this instance…"
              : "Could not check whether the PM agent can run. You can turn it on later in the project's PM agent settings."}
          </p>
        </div>
      ) : setup.setup.pmAvailable ? (
        <Switch
          checked={state.pmEnabled}
          onChange={(pmEnabled) => onChange({ pmEnabled })}
          label="PM agent"
          hint="Answers questions about the board and drafts tasks. Autonomous reviews stay off until you enable them in Settings → PM agent."
        />
      ) : (
        <div>
          <span className="block text-[13.5px] font-medium">PM agent</span>
          <p className="mt-0.5 text-xs text-text-muted">{pmUnavailable(setup.setup)}</p>
        </div>
      )}

      <PeoplePicker
        chosen={state.people}
        you={you}
        onAdd={addPerson}
        onRelation={setRelation}
        onRemove={(id) => onChange({ people: state.people.filter((p) => p.person._id !== id) })}
      />

      <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-[12.5px] text-text-muted">
        All other integrations can be found in Settings → Integrations.
      </p>
    </>
  );
}
