"use client";

import { Suspense, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { STATUS_LABELS, PRIORITY_LABELS } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { PageHeader } from "@/components/shell/PageHeader";
import { useProjects } from "@/hooks/use-projects";
import { MIN_QUERY, SearchHit, columnOf, useSearch } from "@/components/search/use-search";

interface Group {
  key: string;
  label: string;
  hits: SearchHit[];
}

/** Task hits gathered under the project they belong to, in the order the API returned them */
function byProject(hits: SearchHit[]): Group[] {
  const groups: Group[] = [];
  const seen = new Map<string, Group>();
  for (const hit of hits) {
    if (hit.kind !== "task") continue;
    const key = hit.projectId ?? hit.projectKey ?? "";
    let group = seen.get(key);
    if (!group) {
      group = {
        key,
        label: hit.projectKey ? `${hit.projectName ?? ""} (${hit.projectKey})` : (hit.projectName ?? ""),
        hits: [],
      };
      seen.set(key, group);
      groups.push(group);
    }
    group.hits.push(hit);
  }
  return groups;
}

function SearchContent() {
  const { projects } = useProjects();
  const inputRef = useRef<HTMLInputElement>(null);

  // Read once: after this the box owns the query and writes the address, not the other way round
  const initialQuery = useSearchParams().get("q") ?? "";
  const { query, setQuery, trimmed, active, loading, hits } = useSearch(
    projects,
    undefined,
    initialQuery
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The address follows the box so the page stays linkable. `history.replaceState`, not
  // `router.replace`: a router navigation queued here lands *after* a result the reader has
  // just clicked and takes them back to the search page. Nothing on this page reads the
  // address after the first render, so the bare history entry is enough.
  const inTheAddress = useRef(initialQuery);
  useEffect(() => {
    if (inTheAddress.current === trimmed) return;
    const timer = setTimeout(() => {
      inTheAddress.current = trimmed;
      const next = trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search";
      window.history.replaceState(window.history.state, "", next);
    }, 300);
    return () => clearTimeout(timer);
  }, [trimmed]);

  const projectHits = hits.filter((hit) => hit.kind === "project");
  const taskGroups = byProject(hits);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader title="Search" />

      {/* No submit handler: the hook searches as the box changes, and Enter would only fire
          the same request a second time — the defect BP-406 fixed here once already. */}
      <form onSubmit={(e) => e.preventDefault()} className="mb-6">
        <div className="relative">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search tasks and projects"
            placeholder="Search tasks by title, description, or key (e.g. CP-12)…"
            className="focus-ring w-full rounded-lg border border-border bg-bg-input py-2.5 pl-10 pr-4
              text-text placeholder:text-text-muted"
          />
        </div>
      </form>

      {loading && (
        <div className="flex justify-center py-8" role="status" aria-label="Searching">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {!loading && active && hits.length === 0 && (
        <p className="py-8 text-center text-text-muted">No tasks found</p>
      )}

      {!loading && !active && trimmed.length > 0 && (
        <p className="py-8 text-center text-text-muted">
          Keep typing — {MIN_QUERY} characters at least
        </p>
      )}

      {!loading && projectHits.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-text-muted">Projects</h2>
          <div className="overflow-hidden rounded-lg border border-border">
            {projectHits.map((hit, i) => (
              <Link
                key={hit.id}
                href={hit.href}
                className={`flex items-center gap-2.5 px-4 py-3 transition-colors hover:bg-bg-input/50
                  ${i > 0 ? "border-t border-border" : ""}`}
              >
                {hit.icon && (
                  <span aria-hidden className="text-[15px] leading-none">
                    {hit.icon}
                  </span>
                )}
                <span className="truncate text-sm font-medium">{hit.label}</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-text-muted">
                  {hit.meta}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {!loading &&
        taskGroups.map((group) => (
          <div key={group.key} className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-text-muted">{group.label}</h2>
            <div className="overflow-hidden rounded-lg border border-border">
              {group.hits.map((hit, i) => {
                const column = columnOf(hit, projects);
                return (
                  <Link
                    key={hit.id}
                    href={hit.href}
                    className={`flex flex-col items-start gap-1.5 px-4 py-3 transition-colors hover:bg-bg-input/50 md:flex-row md:items-center md:gap-3
                    ${i > 0 ? "border-t border-border" : ""}`}
                  >
                    <span className="flex min-w-0 max-w-full items-center gap-2 md:flex-1">
                      <span className="whitespace-nowrap font-mono text-xs text-text-muted">
                        {hit.meta}
                      </span>
                      <span className="truncate text-sm font-medium">{hit.label}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {hit.status && (
                        <Badge variant="status" value={hit.status} color={column?.color}>
                          {column?.label ?? STATUS_LABELS[hit.status] ?? hit.status}
                        </Badge>
                      )}
                      {hit.priority && (
                        <Badge variant="priority" value={hit.priority}>
                          {PRIORITY_LABELS[hit.priority] ?? hit.priority}
                        </Badge>
                      )}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <SearchContent />
    </Suspense>
  );
}
