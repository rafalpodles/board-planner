"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { estimateToolTokens } from "@/lib/pm/tool-budget";

export interface McpCatalogTool {
  name: string;
  description: string;
  readSafe: boolean;
}

interface Props {
  rowName: string;
  catalog?: McpCatalogTool[];
  allowlist: string;
  onChange: (value: string) => void;
}

export function parseAllowlist(value: string): string[] {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Picking tools used to mean typing their names into a bare text field, which only works if you
 * already know the catalogue — and "Test connection" answered with 86 names on one line and no
 * descriptions (BP-569). The stored shape is unchanged: a comma-separated list, so an allowlist
 * written before this still loads and can still be edited by hand when the server is unreachable.
 */
export function McpToolPicker({ rowName, catalog, allowlist, onChange }: Props) {
  const [filter, setFilter] = useState("");
  const selected = useMemo(() => new Set(parseAllowlist(allowlist)), [allowlist]);

  const visible = useMemo(() => {
    if (!catalog) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return catalog;
    return catalog.filter(
      (t) => t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle)
    );
  }, [catalog, filter]);

  function toggle(name: string) {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange([...next].join(", "));
  }

  // An empty allowlist means every tool the server offers, so the count shown has to be the
  // catalogue size — reading it as zero is exactly the misunderstanding that let 86 through.
  const effectiveCount = selected.size > 0 ? selected.size : (catalog?.length ?? 0);

  return (
    <div className="flex flex-col gap-2">
      <Input
        aria-label={`Tool allowlist for ${rowName}`}
        value={allowlist}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Tool allowlist, comma-separated (empty = all)"
      />

      {catalog && catalog.length > 0 && (
        <div className="rounded-md border border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
            <span className="text-xs text-text-muted">
              {selected.size > 0
                ? `${selected.size} of ${catalog.length} selected`
                : `All ${catalog.length} tools — none ticked`}
              {" · roughly "}
              {estimateToolTokens(effectiveCount).toLocaleString()} tokens per model call
            </span>
            <div className="ml-auto flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Clear tool selection for ${rowName}`}
                onClick={() => onChange("")}
              >
                Clear
              </Button>
            </div>
          </div>

          {catalog.length > 8 && (
            <div className="p-2">
              <Input
                aria-label={`Filter tools for ${rowName}`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter tools"
              />
            </div>
          )}

          <ul className="max-h-64 overflow-y-auto p-2">
            {visible.map((tool) => (
              <li key={tool.name}>
                <label className="flex cursor-pointer items-start gap-2 rounded p-1 hover:bg-bg-hover">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(tool.name)}
                    onChange={() => toggle(tool.name)}
                    aria-label={`${tool.name} for ${rowName}`}
                  />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1 text-sm">
                      <code className="text-xs">{tool.name}</code>
                      {!tool.readSafe && (
                        <span className="rounded border border-warning px-1 text-[10px] uppercase text-warning">
                          writes
                        </span>
                      )}
                    </span>
                    {tool.description && (
                      <span className="block text-xs text-text-muted">{tool.description}</span>
                    )}
                  </span>
                </label>
              </li>
            ))}
            {visible.length === 0 && (
              <li className="p-1 text-xs text-text-muted">No tool matches that filter.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
