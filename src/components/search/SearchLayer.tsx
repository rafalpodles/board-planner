"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useProjects } from "@/hooks/use-projects";
import { openLayerCount } from "@/lib/focus-trap";
import { projectRefFromPathname } from "@/lib/urls";
import { STATUS_LABELS } from "@/types";
import { MIN_QUERY, SearchHit, columnOf, groupOf, useSearch } from "./use-search";

const GROUP_LABELS = { current: "In this project", other: "Other projects" } as const;

interface Run {
  group: string;
  label: string | null;
  items: { hit: SearchHit; index: number }[];
}

/** Indices stay flat across runs, so ↑↓ walk the whole list without knowing about groups */
function runsOf(hits: SearchHit[], currentProjectRef?: string): Run[] {
  const numbered = hits.map((hit, index) => ({ hit, index }));
  if (!currentProjectRef) return [{ group: "all", label: null, items: numbered }];
  return (["current", "other"] as const)
    .map((group) => ({
      group,
      label: GROUP_LABELS[group],
      items: numbered.filter(({ hit }) => groupOf(hit, currentProjectRef) === group),
    }))
    .filter((run) => run.items.length > 0);
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

function useSearchShortcut(onOpen: () => void, onClose: () => void, open: boolean) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const cmdK = (e.metaKey || e.ctrlKey) && e.key === "k";
      const slash =
        e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target);
      if (!cmdK && !slash) return;
      e.preventDefault();
      // On the way in only: the open palette is a layer itself, and ⌘K has to keep closing it
      if (!open && openLayerCount() > 0) return;
      if (open && cmdK) onClose();
      else if (!open) onOpen();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onOpen, onClose, open]);
}

interface SearchLayerProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export function SearchLayer({ open, onOpen, onClose }: SearchLayerProps) {
  const { projects } = useProjects();
  const currentProjectRef = projectRefFromPathname(usePathname());
  const search = useSearch(projects, currentProjectRef);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useSearchShortcut(onOpen, onClose, open);

  useFocusTrap({ active: open, containerRef: dialogRef, onEscape: onClose });

  const { reset } = search;
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else reset();
  }, [open, reset]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [search.selectedIndex]);

  if (!open) return null;

  const { hits, loading, failed, active, trimmed, selectedIndex } = search;

  function close(hit?: SearchHit) {
    if (hit) search.open(hit);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (!hits.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      search.setSelectedIndex((selectedIndex + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      search.setSelectedIndex((selectedIndex - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      close(hits[selectedIndex]);
    }
  }

  // z-[60], not z-50: the PM FAB is z-50 and would float over the mobile sheet
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 sm:pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        tabIndex={-1}
        className="flex h-dvh w-full flex-col overflow-hidden bg-bg-card sm:h-auto sm:max-h-[70vh] sm:w-[640px] sm:rounded-xl sm:border sm:border-border sm:shadow-2xl"
      >
        {/* No focus-ring class on the input: it is focused from the moment the layer
            opens and the caret marks it, where a 2px box would read as a validation error */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4">
          <svg
            className="h-5 w-5 shrink-0 text-text-muted"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={search.query}
            onChange={(e) => search.setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search tasks and projects"
            aria-label="Search tasks and projects"
            className="min-w-0 flex-1 rounded bg-transparent py-3.5 text-sm text-text outline-none placeholder:text-text-muted"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="focus-ring shrink-0 rounded border border-border bg-bg-input px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
          >
            ESC
          </button>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {/* Above the results rather than instead of them: a project match is computed here from
              the projects already in hand, so it survives the task endpoint being down */}
          {!loading && failed && active && (
            <div role="alert" className="flex items-center justify-between gap-3 px-2 py-3">
              <p className="text-[13px] text-text-muted">The task search failed.</p>
              <button
                type="button"
                onClick={() => {
                  search.retry();
                  inputRef.current?.focus();
                }}
                className="focus-ring rounded text-[13px] text-primary underline"
              >
                Retry
              </button>
            </div>
          )}
          {!active ? (
            <p className="px-2 py-3 text-[13px] text-text-muted">
              Type at least {MIN_QUERY} characters to search
            </p>
          ) : !hits.length ? (
            // Nothing to say about matches when the read failed — the alert above says it
            loading ? (
              <p className="px-2 py-3 text-[13px] text-text-muted">Searching…</p>
            ) : failed ? null : (
              <p className="px-2 py-3 text-[13px] text-text-muted">No matches</p>
            )
          ) : (
            <div role="listbox" aria-label="Search results" className="flex flex-col">
              {runsOf(hits, currentProjectRef).map((run) => (
                <div
                  key={run.group}
                  role={run.label ? "group" : undefined}
                  aria-label={run.label ?? undefined}
                  className="flex flex-col gap-px"
                >
                  {run.label && (
                    <span className="px-2 pb-1 pt-3 text-[10.5px] font-bold uppercase tracking-wider text-text-muted">
                      {run.label}
                    </span>
                  )}
                  {run.items.map(({ hit, index }) => {
                    const column = columnOf(hit, projects);
                    return (
                      <button
                        key={hit.id}
                        type="button"
                        role="option"
                        aria-selected={index === selectedIndex}
                        data-selected={index === selectedIndex}
                        onMouseEnter={() => search.setSelectedIndex(index)}
                        onClick={() => close(hit)}
                        className={`focus-ring flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left text-[13px] transition-colors ${
                          index === selectedIndex
                            ? "bg-bg-hover text-text"
                            : "text-text-muted hover:bg-bg-hover"
                        }`}
                      >
                        {hit.icon && (
                          <span aria-hidden className="mt-px text-[15px] leading-none">
                            {hit.icon}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 text-text">{hit.label}</span>
                        {hit.status && (
                          <Badge variant="status" value={hit.status} color={column?.color}>
                            {column?.label ?? STATUS_LABELS[hit.status] ?? hit.status}
                          </Badge>
                        )}
                        <span className="shrink-0 font-mono text-[11px] text-text-muted">
                          {hit.meta}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-border px-4 py-2 text-[10px] text-text-muted">
          <span className="flex items-center gap-3">
            <span>
              <kbd className="rounded border border-border bg-bg-input px-1 py-0.5 font-mono">
                ↑↓
              </kbd>{" "}
              navigate
            </span>
            <span>
              <kbd className="rounded border border-border bg-bg-input px-1 py-0.5 font-mono">↵</kbd>{" "}
              open
            </span>
          </span>
          {active && (
            <Link
              href={`/search?q=${encodeURIComponent(trimmed)}`}
              onClick={onClose}
              className="focus-ring rounded px-1 py-0.5 text-text-muted underline-offset-2 hover:text-text hover:underline"
            >
              See all results
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
