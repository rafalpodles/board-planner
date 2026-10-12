"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { MAX_CATEGORIES, CATEGORY_NAME_MAX_LENGTH } from "@/lib/identifiers";
import { MAX_OPTION_VALUE_LENGTH } from "@/lib/custom-fields";
import { NEW_ITEM_COLOR, type WizardState } from "./wizard-model";

interface FieldsStepProps {
  state: WizardState;
  onChange: (patch: Partial<WizardState>) => void;
}

type Group = "categories" | "components" | "labels";

const GROUPS: {
  id: Group;
  title: string;
  hint: string;
  modes: [string, string][];
  placeholder: string;
  max: number;
  maxLength: number;
}[] = [
  {
    id: "categories",
    title: "Categories",
    hint: "Used to tint cards and filter the board.",
    modes: [["default", "Keep defaults"], ["empty", "Start empty"], ["custom", "Edit"]],
    placeholder: "New category",
    max: MAX_CATEGORIES,
    maxLength: CATEGORY_NAME_MAX_LENGTH,
  },
  {
    id: "components",
    title: "Components",
    hint: "The parts of the product a task touches.",
    modes: [["empty", "Start empty"], ["custom", "Add a few"]],
    placeholder: "New component",
    max: 100,
    maxLength: MAX_OPTION_VALUE_LENGTH,
  },
  {
    id: "labels",
    title: "Labels",
    hint: "Free-form tags on a task.",
    modes: [["empty", "Start empty"], ["custom", "Add a few"]],
    placeholder: "New label",
    max: 100,
    maxLength: MAX_OPTION_VALUE_LENGTH,
  },
];

function namesOf(state: WizardState, group: Group): string[] {
  if (group === "categories") {
    return state.categories.mode === "empty" ? [] : state.categories.items.map((c) => c.name);
  }
  const { mode, items } = state[group];
  return mode === "empty" ? [] : items;
}

export function FieldsStep({ state, onChange }: FieldsStepProps) {
  const [drafts, setDrafts] = useState<Record<Group, string>>({ categories: "", components: "", labels: "" });
  const [announcement, setAnnouncement] = useState("");
  const refocus = useRef<Group | null>(null);

  // The button that was pressed goes away or goes grey; the field it fed is where to carry on
  useEffect(() => {
    if (!refocus.current) return;
    document.getElementById(`wizard-add-${refocus.current}`)?.focus();
    refocus.current = null;
  });

  function setMode(group: Group, mode: string) {
    if (group === "categories") {
      onChange({ categories: { ...state.categories, mode: mode as WizardState["categories"]["mode"] } });
    } else {
      onChange({ [group]: { ...state[group], mode: mode as "empty" | "custom" } } as Partial<WizardState>);
    }
  }
  function add(group: Group) {
    const name = drafts[group].trim();
    if (!name) return;
    if (namesOf(state, group).some((n) => n.toLowerCase() === name.toLowerCase())) return;
    if (group === "categories") {
      onChange({
        categories: { ...state.categories, items: [...state.categories.items, { name, color: NEW_ITEM_COLOR }] },
      });
    } else {
      onChange({ [group]: { ...state[group], items: [...state[group].items, name] } } as Partial<WizardState>);
    }
    setDrafts({ ...drafts, [group]: "" });
    refocus.current = group;
    setAnnouncement(`${name} added`);
  }
  function remove(group: Group, index: number) {
    refocus.current = group;
    setAnnouncement(`${namesOf(state, group)[index]} removed`);
    if (group === "categories") {
      onChange({
        categories: { ...state.categories, items: state.categories.items.filter((_, i) => i !== index) },
      });
    } else {
      onChange({
        [group]: { ...state[group], items: state[group].items.filter((_, i) => i !== index) },
      } as Partial<WizardState>);
    }
  }

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {GROUPS.map((g) => {
        const mode = state[g.id].mode;
        const names = namesOf(state, g.id);
        const editable = mode === "custom";
        const colors = g.id === "categories" ? state.categories.items.map((c) => c.color) : [];
        const modeLabelId = `fields-${g.id}`;
        return (
          <section key={g.id} aria-labelledby={modeLabelId} className="flex flex-col gap-2.5 rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 id={modeLabelId} className="text-[13.5px] font-semibold">
                  {g.title}
                </h3>
                <p className="text-xs text-text-muted">{g.hint}</p>
              </div>
              <div role="group" aria-label={`${g.title} to start with`} className="inline-flex rounded-lg border border-border bg-bg-card p-0.5">
                {g.modes.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={mode === value}
                    onClick={() => setMode(g.id, value)}
                    className={`focus-ring min-h-11 rounded-md px-3 text-sm sm:min-h-9 ${
                      mode === value ? "bg-primary-solid font-semibold text-white" : "text-text-muted hover:text-text"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <ul className="flex min-h-7 flex-wrap items-center gap-1.5">
              {names.length === 0 && (
                <li className="text-xs text-text-muted">
                  {mode === "empty" ? "None. Add them later in Settings → Task fields." : "Nothing yet."}
                </li>
              )}
              {names.map((name, i) => {
                const color = colors[i] ?? "#64748b";
                return (
                  <li
                    key={`${name}-${i}`}
                    className="inline-flex min-w-0 max-w-full items-center gap-1 break-words rounded-full px-2.5 py-0.5 text-xs font-semibold"
                    style={{
                      background: `color-mix(in srgb, ${color} 18%, var(--color-bg-card))`,
                      color: `color-mix(in srgb, ${color} 40%, var(--color-text))`,
                    }}
                  >
                    {name}
                    {editable && (
                      <button
                        type="button"
                        onClick={() => remove(g.id, i)}
                        aria-label={`Remove ${name}`}
                        className="focus-ring -my-2 -mr-2 grid h-9 w-9 shrink-0 place-items-center rounded-full leading-none"
                      >
                        ✕
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {editable && (
              <div className="flex gap-2">
                <input
                  id={`wizard-add-${g.id}`}
                  value={drafts[g.id]}
                  aria-label={g.placeholder}
                  placeholder={g.placeholder}
                  maxLength={g.maxLength}
                  onChange={(e) => setDrafts({ ...drafts, [g.id]: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      add(g.id);
                    }
                  }}
                  className="focus-ring min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-bg-input px-3 py-1.5 text-text placeholder:text-text-muted sm:min-h-10"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => add(g.id)}
                  disabled={!drafts[g.id].trim() || names.length >= g.max}
                >
                  Add
                </Button>
              </div>
            )}
          </section>
        );
      })}
      <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-[12.5px] text-text-muted">
        <b className="font-semibold text-text">Custom fields and task templates</b> are configured in
        Settings → Task fields once the project exists.
      </p>
    </>
  );
}
