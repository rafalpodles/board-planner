"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiTask, STATUS_LABELS } from "@/types";
import { Badge } from "@/components/ui/Badge";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ApiTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const api = useApi();
  const router = useRouter();

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Debounced search
  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const doSearch = useCallback(
    async (q: string) => {
      if (q.trim().length < 2) {
        setResults([]);
        return;
      }
      setLoading(true);
      try {
        const data = await api.get(`/api/search?q=${encodeURIComponent(q.trim())}`);
        setResults(data);
        setSelectedIndex(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [api]
  );

  useEffect(() => {
    clearTimeout(searchTimeout.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    searchTimeout.current = setTimeout(() => doSearch(query), 200);
    return () => clearTimeout(searchTimeout.current);
  }, [query, doSearch]);

  function navigateToResult(task: ApiTask) {
    const projectId =
      typeof task.project === "object" && task.project !== null
        ? (task.project as unknown as { _id: string })._id
        : task.project;
    router.push(`/projects/${projectId}/tasks/${task._id}`);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter" && results.length > 0) {
      e.preventDefault();
      navigateToResult(results[selectedIndex]);
      return;
    }
  }

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[selectedIndex] as HTMLElement;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div className="fixed inset-0 bg-black/50" />
      <div
        className="relative bg-bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 border-b border-border">
          <svg className="w-5 h-5 text-text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search tasks by title or key (e.g. CP-12)..."
            className="flex-1 bg-transparent py-3.5 text-sm focus:outline-none placeholder:text-text-muted"
          />
          <kbd className="text-[10px] text-text-muted bg-bg-input border border-border px-1.5 py-0.5 rounded font-mono">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto">
          {loading && (
            <div className="flex justify-center py-6">
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            </div>
          )}

          {!loading && query.trim().length >= 2 && results.length === 0 && (
            <p className="text-sm text-text-muted text-center py-6">
              No tasks found
            </p>
          )}

          {!loading && query.trim().length < 2 && (
            <p className="text-sm text-text-muted text-center py-6">
              Type at least 2 characters to search
            </p>
          )}

          {!loading &&
            results.map((task, index) => {
              const proj =
                typeof task.project === "object" && task.project !== null
                  ? (task.project as unknown as { key: string; name: string })
                  : null;
              return (
                <button
                  key={task._id}
                  onClick={() => navigateToResult(task)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${
                    index === selectedIndex
                      ? "bg-primary/10"
                      : "hover:bg-bg-hover"
                  }`}
                >
                  <span className="text-xs font-mono text-text-muted whitespace-nowrap">
                    {proj ? `${proj.key}-${task.taskNumber}` : `#${task.taskNumber}`}
                  </span>
                  <span className="text-sm flex-1 truncate">{task.title}</span>
                  <Badge variant="status" value={task.status}>
                    {STATUS_LABELS[task.status]}
                  </Badge>
                </button>
              );
            })}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-4 py-2 flex items-center gap-4 text-[10px] text-text-muted">
          <span>
            <kbd className="bg-bg-input border border-border px-1 py-0.5 rounded font-mono">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="bg-bg-input border border-border px-1 py-0.5 rounded font-mono">↵</kbd> open
          </span>
          <span>
            <kbd className="bg-bg-input border border-border px-1 py-0.5 rounded font-mono">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
