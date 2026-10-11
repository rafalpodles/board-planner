"use client";

import { useId } from "react";
import { Input } from "@/components/ui/Input";
import { openrouterModel } from "@/lib/managed-models";

export interface ModelCatalogue {
  restricted: boolean;
  model: string;
  models: { id: string; name: string }[] | null;
  providers: { id: string; label: string }[] | null;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** A choice is final: on picking from the list, and on leaving a typed name */
  onCommit?: (value: string) => void;
  catalogue: ModelCatalogue;
  label?: string;
  ariaLabel?: string;
  /** Offered first, and picking it clears the field: a project that follows the default */
  emptyLabel?: string;
  placeholder?: string;
  className?: string;
}

/**
 * On our key only the allowed providers' models run, so those are a list and nothing else can be chosen. On the
 * organisation's own key every OpenRouter model runs: the list is a suggestion and a typed name is judged on saving.
 */
export function ModelPicker({ value, onChange, onCommit, catalogue, label, ariaLabel, emptyLabel, placeholder, className = "" }: Props) {
  const id = useId();
  const { models, restricted, providers } = catalogue;

  if (models && restricted) {
    const listed = models.some((m) => m.id === openrouterModel(value));
    const groups = new Map<string, { id: string; name: string }[]>();
    for (const m of models) groups.set(m.id.split("/")[0], [...(groups.get(m.id.split("/")[0]) ?? []), m]);
    return (
      <div className="w-full">
        {label && (
          <label htmlFor={id} className="mb-1 flex items-center gap-2 text-sm font-medium text-text-muted">
            {label}
          </label>
        )}
        <select
          id={id}
          aria-label={label ? undefined : ariaLabel}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            onCommit?.(e.target.value);
          }}
          className={`focus-ring w-full min-h-[44px] rounded-lg border border-border bg-bg-input px-2 py-2 text-sm text-text ${className}`}
        >
          {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
          {value && !listed && <option value={value}>{value} — not available on our key</option>}
          {[...groups].map(([provider, rows]) => (
            <optgroup key={provider} label={providers?.find((p) => p.id === provider)?.label ?? provider}>
              {rows.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    );
  }

  return (
    <>
      <Input
        label={label}
        aria-label={label ? undefined : ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit?.(e.target.value)}
        list={models ? `${id}-models` : undefined}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={className}
      />
      {models && (
        <datalist id={`${id}-models`}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </datalist>
      )}
    </>
  );
}
