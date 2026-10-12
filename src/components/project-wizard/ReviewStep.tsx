"use client";

import { Button } from "@/components/ui/Button";
import { repositoryProvider } from "@/lib/repository";
import { ROLE_LABELS } from "@/types";
import { columnsOf, type WizardState } from "./wizard-model";

interface ReviewStepProps {
  state: WizardState;
  you: string;
  error: string;
  onEdit: (stepIndex: number) => void;
}

const PRESET_NAMES = { default: "Default", simple: "Simple", custom: "Custom" } as const;
const nameOf = (p: { fullName: string; username: string }) => p.fullName || p.username;

function Group({
  title,
  onEdit,
  rows,
}: {
  title: string;
  onEdit: () => void;
  rows: [string, React.ReactNode][];
}) {
  return (
    <section aria-label={title} className="rounded-xl border border-border">
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <h3 className="flex-1 text-[13.5px] font-semibold">{title}</h3>
        <Button type="button" variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${title}`}>
          Edit
        </Button>
      </header>
      <dl className="px-3 py-1">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid gap-0.5 border-b border-border py-2 text-[13px] last:border-b-0 sm:grid-cols-[130px_minmax(0,1fr)] sm:gap-3"
          >
            <dt className="text-text-muted">{label}</dt>
            <dd className="m-0 min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const none = <span className="text-text-muted">None</span>;

function list(names: string[]) {
  return names.length > 0 ? names.join(", ") : none;
}

export function ReviewStep({ state, you, error, onEdit }: ReviewStepProps) {
  const columns = columnsOf(state);
  const url = state.repositoryUrl.trim();
  const provider = url ? repositoryProvider({ repositoryUrl: url }, "https://github.com") : "";
  const categories = state.categories.mode === "empty" ? [] : state.categories.items.map((c) => c.name);
  const components = state.components.mode === "empty" ? [] : state.components.items;
  const labels = state.labels.mode === "empty" ? [] : state.labels.items;
  const access = [
    `${you} (you, owner)`,
    ...state.people.map((p) => `${nameOf(p.person)} (${p.relation})`),
  ];
  const shown = access.length > 4 ? `${access.slice(0, 3).join(", ")} and ${access.length - 3} more` : access.join(", ");

  return (
    <>
      {error && (
        <p role="alert" className="rounded-xl border border-danger/50 bg-danger/10 px-3 py-2.5 text-[13px]">
          <b className="text-danger">Project not created.</b> {error} Nothing was saved.
        </p>
      )}
      <Group
        title="Basics"
        onEdit={() => onEdit(0)}
        rows={[
          ["Name", `${state.icon} ${state.name.trim()}`],
          ["Key", <span key="k" className="font-mono">{state.key.trim().toUpperCase()}</span>],
          ["Description", state.description.trim() || none],
        ]}
      />
      <Group
        title="Workflow"
        onEdit={() => onEdit(1)}
        rows={[
          ["Preset", `${PRESET_NAMES[state.preset]} · ${columns.length} columns`],
          ["Columns", columns.map((c) => c.label).join(" → ")],
          ["Roles", columns.map((c) => `${c.label}: ${ROLE_LABELS[c.role].label}`).join("; ")],
        ]}
      />
      <Group
        title="Task fields"
        onEdit={() => onEdit(2)}
        rows={[
          ["Categories", list(categories)],
          ["Components", list(components)],
          ["Labels", list(labels)],
        ]}
      />
      <Group
        title="Automation & access"
        onEdit={() => onEdit(3)}
        rows={[
          [
            "Repository",
            url ? (
              <span key="r">
                <span className="font-mono">{url}</span>
                {provider === "github" && " · GitHub"}
                {provider === "gitlab" && " · GitLab"}
              </span>
            ) : (
              <span className="text-text-muted">Not connected</span>
            ),
          ],
          ["PM agent", state.pmEnabled ? "On, autonomy off" : "Off"],
          ["Access", shown],
        ]}
      />
    </>
  );
}
