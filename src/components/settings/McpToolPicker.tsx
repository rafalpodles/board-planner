"use client";

import { useId, useMemo, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { estimateToolTokens, MAX_TOOL_ALLOWLIST } from "@/lib/pm/tool-budget";

export interface McpCatalogTool {
  name: string;
  description: string;
  readSafe: boolean;
}

interface Props {
  rowName: string;
  catalog?: McpCatalogTool[];
  allowlist: string;
  allowWrites: boolean;
  onChange: (value: string) => void;
}

export function parseAllowlist(value: string): string[] {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function carriedTools(
  catalog: McpCatalogTool[] | undefined,
  allowlist: string,
  allowWrites: boolean
): string[] {
  const reachable = (catalog ?? []).filter((t) => allowWrites || t.readSafe);
  const ticked = new Set(parseAllowlist(allowlist));
  if (ticked.size === 0) return reachable.map((t) => t.name);
  return catalog ? reachable.filter((t) => ticked.has(t.name)).map((t) => t.name) : [...ticked];
}

export function McpToolPicker({ rowName, catalog, allowlist, allowWrites, onChange }: Props) {
  const [filter, setFilter] = useState("");
  const selected = useMemo(() => new Set(parseAllowlist(allowlist)), [allowlist]);

  const tools = useMemo(() => {
    const seen = new Set<string>();
    return (catalog ?? []).filter((t) => !seen.has(t.name) && seen.add(t.name));
  }, [catalog]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return tools;
    return tools.filter(
      (t) => t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle)
    );
  }, [tools, filter]);

  const carried = carriedTools(catalog, allowlist, allowWrites);
  const listed = new Set(parseAllowlist(allowlist)).size;
  const slug = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "-");
  const fieldId = useId();
  const overCap = listed > MAX_TOOL_ALLOWLIST;
  const atCap = selected.size >= MAX_TOOL_ALLOWLIST;

  function toggle(name: string, blocked: boolean) {
    if (blocked && !selected.has(name)) return;
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange([...next].join(", "));
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        aria-label={`Tool allowlist for ${rowName}`}
        aria-describedby={overCap ? `${fieldId}-cap` : undefined}
        value={allowlist}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Tool allowlist, comma-separated (empty = all)"
      />
      <p
        role="status"
        aria-live="polite"
        id={`${fieldId}-cap`}
        className={overCap ? "text-xs text-danger" : "sr-only"}
      >
        {overCap
          ? `${listed} tools listed. ${MAX_TOOL_ALLOWLIST} is the most one server can have, and saving will be refused until you remove some.`
          : ""}
      </p>

      {tools.length > 0 && (
        <div className="rounded-md border border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
            <span className="text-xs text-text-muted">
              {selected.size > 0
                ? `${tools.filter((t) => selected.has(t.name)).length} of ${tools.length} ticked`
                : `Nothing ticked, so every tool this server offers is used`}
              {` · ${carried.length} carried per turn, roughly ${estimateToolTokens(carried.length)} tokens per model call`}
            </span>
            <div className="ml-auto flex gap-2">
              {selected.size > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`Use every tool from ${rowName}`}
                  onClick={() => onChange("")}
                >
                  Use all tools
                </Button>
              )}
            </div>
          </div>

          <p
            role="status"
            aria-live="polite"
            className={
              atCap ? "border-b border-border p-2 text-xs text-warning" : "sr-only"
            }
          >
            {atCap
              ? `${MAX_TOOL_ALLOWLIST} tools is the most one server can list. Untick something to choose another.`
              : ""}
          </p>

          {tools.length > 8 && (
            <div className="p-2">
              <Input
                aria-label={`Filter tools for ${rowName}`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter tools"
              />
            </div>
          )}

          <div role="group" aria-label={`Tools offered by ${rowName}`}>
          <ul className="max-h-64 overflow-y-auto p-2">
            {visible.map((tool) => {
              const unreachable = !tool.readSafe && !allowWrites;
              const blocked = unreachable || (atCap && !selected.has(tool.name));
              return (
                <li key={tool.name}>
                  <label
                    className={`flex items-start gap-2 rounded p-1 ${
                      blocked ? "opacity-60" : "cursor-pointer hover:bg-bg-hover"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selected.has(tool.name)}
                      aria-disabled={blocked}
                      onChange={() => toggle(tool.name, blocked)}
                      aria-label={`${tool.name} for ${rowName}`}
                      aria-describedby={`${fieldId}-${slug(tool.name)}`}
                    />
                    <span className="min-w-0" id={`${fieldId}-${slug(tool.name)}`}>
                      <span className="flex flex-wrap items-center gap-1 text-sm">
                        <code className="text-xs">{tool.name}</code>
                        {!tool.readSafe && (
                          <span className="rounded border border-warning px-1 text-[10px] uppercase text-warning">
                            writes
                          </span>
                        )}
                        {unreachable && (
                          <span className="text-[10px] text-text-muted">
                            needs Allow writes
                          </span>
                        )}
                        {blocked && !unreachable && (
                          <span className="text-[10px] text-text-muted">
                            at the {MAX_TOOL_ALLOWLIST}-tool limit
                          </span>
                        )}
                      </span>
                      {tool.description && (
                        <span className="block text-xs text-text-muted">{tool.description}</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
            {visible.length === 0 && (
              <li className="p-1 text-xs text-text-muted">No tool matches that filter.</li>
            )}
          </ul>
          </div>
        </div>
      )}
    </div>
  );
}
