"use client";

import { useMemo, useState } from "react";
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

/**
 * What a turn will actually carry from one server: an empty allowlist means every tool, and a
 * server without `allowWrites` silently drops its mutating tools at discovery. Both callers of
 * this — the picker's own counter and the settings banner — have to agree with `discoverMcpTools`
 * or they describe a turn that does not happen (BP-569 review).
 */
export function carriedTools(
  catalog: McpCatalogTool[] | undefined,
  allowlist: string,
  allowWrites: boolean
): string[] {
  const reachable = (catalog ?? []).filter((t) => allowWrites || t.readSafe);
  const ticked = new Set(parseAllowlist(allowlist));
  if (ticked.size === 0) return reachable.map((t) => t.name);
  // Catalogue ENTRIES matching a ticked name, not the ticked names themselves: a tool offered
  // twice and ticked once is admitted twice by `discoverMcpTools`, under a `_2` suffix. Filtering
  // the names instead collapsed that to one and under-reported the normal, post-picker state
  // (BP-569 review 3). A name typed by hand against a server that was never tested has no
  // catalogue to check, so it counts — refusing it would make the free-text fallback read zero.
  return catalog ? reachable.filter((t) => ticked.has(t.name)).map((t) => t.name) : [...ticked];
}

/**
 * Picking tools used to mean typing their names into a bare text field, which only works if you
 * already know the catalogue — and "Test connection" answered with 86 names on one line and no
 * descriptions (BP-569). The stored shape is unchanged: a comma-separated list, so an allowlist
 * written before this still loads and can still be edited by hand when the server is unreachable.
 */
export function McpToolPicker({ rowName, catalog, allowlist, allowWrites, onChange }: Props) {
  const [filter, setFilter] = useState("");
  const selected = useMemo(() => new Set(parseAllowlist(allowlist)), [allowlist]);

  // First name wins. A server offering the same name twice would otherwise share one React key,
  // one label and one checkbox between two rows, so ticking either flipped both.
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

  // The raw catalogue, not the de-duplicated render list: `discoverMcpTools` keeps a name offered
  // twice as two tools, so counting the de-duplicated list under-reports what the turn carries.
  const carried = carriedTools(catalog, allowlist, allowWrites);
  // De-duplicated, because `savePm` de-duplicates before posting: counting raw entries warned
  // that a save would be refused when it would in fact succeed (BP-569 review 3).
  const listed = new Set(parseAllowlist(allowlist)).size;
  const fieldId = `mcp-tools-${rowName.replace(/\s+/g, "-")}`;
  const overCap = listed > MAX_TOOL_ALLOWLIST;
  const atCap = selected.size >= MAX_TOOL_ALLOWLIST;

  function toggle(name: string, blocked: boolean) {
    // `aria-disabled` is an announcement, not an enforcement: this is what actually refuses
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
      {/* The checkbox cap cannot see a pasted list, and the validator refuses the whole PM save
          rather than this field, so the count has to be said here (BP-569 review 2) */}
      {overCap && (
        <p role="status" id={`${fieldId}-cap`} className="text-xs text-danger">
          {listed} tools listed. {MAX_TOOL_ALLOWLIST} is the most one server can have, and saving
          will be refused until you remove some.
        </p>
      )}

      {tools.length > 0 && (
        <div className="rounded-md border border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
            <span className="text-xs text-text-muted">
              {selected.size > 0
                // Ticked names the server actually offers: counting the field verbatim printed
                // "5 of 3 ticked" for names typed against a catalogue without them
                ? `${tools.filter((t) => selected.has(t.name)).length} of ${tools.length} ticked`
                // "offered", not "sent": with writes off, some of them never reach the turn, and
                // the clause after this one says so in the same sentence
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

          {atCap && (
            <p role="status" className="border-b border-border p-2 text-xs text-warning">
              {MAX_TOOL_ALLOWLIST} tools is the most one server can list. Untick something to
              choose another.
            </p>
          )}

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

          <ul
            role="group"
            aria-label={`Tools offered by ${rowName}`}
            className="max-h-64 overflow-y-auto p-2"
          >
            {visible.map((tool) => {
              const unreachable = !tool.readSafe && !allowWrites;
              const blocked = unreachable || (atCap && !selected.has(tool.name));
              return (
                <li key={tool.name}>
                  <label
                    className={`flex items-start gap-2 rounded p-1 ${
                      unreachable ? "opacity-60" : "cursor-pointer hover:bg-bg-hover"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selected.has(tool.name)}
                      // aria-disabled, not disabled: a disabled checkbox leaves the tab order, so
                      // the reason sitting next to it is never reached by a keyboard or a screen
                      // reader — the tool simply is not there (BP-569 review 3)
                      aria-disabled={blocked}
                      onChange={() => toggle(tool.name, blocked)}
                      aria-label={`${tool.name} for ${rowName}`}
                      aria-describedby={`${fieldId}-${tool.name}`}
                    />
                    <span className="min-w-0" id={`${fieldId}-${tool.name}`}>
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
      )}
    </div>
  );
}
