"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiTask, STATUS_LABELS } from "@/types";
import { Badge } from "@/components/ui/Badge";

interface GroupedResult {
  projectId: string;
  projectName: string;
  projectKey: string;
  tasks: ApiTask[];
}

function SearchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const api = useApi();
  const inputRef = useRef<HTMLInputElement>(null);

  const initialQuery = searchParams.get("q") || "";
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<ApiTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!initialQuery) return;
    performSearch(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  async function performSearch(q: string) {
    if (q.trim().length < 2) return;
    setLoading(true);
    setSearched(true);
    try {
      const data = await api.get(`/api/search?q=${encodeURIComponent(q.trim())}`);
      setResults(data);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim().length < 2) return;
    router.replace(`/search?q=${encodeURIComponent(query.trim())}`);
    performSearch(query);
  }

  const grouped: GroupedResult[] = [];
  const projectMap = new Map<string, GroupedResult>();

  for (const task of results) {
    const proj = task.project as unknown as { _id: string; name: string; key: string };
    if (!proj || typeof proj !== "object") continue;
    let group = projectMap.get(proj._id);
    if (!group) {
      group = { projectId: proj._id, projectName: proj.name, projectKey: proj.key, tasks: [] };
      projectMap.set(proj._id, group);
      grouped.push(group);
    }
    group.tasks.push(task);
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Search</h1>

      <form onSubmit={handleSubmit} className="mb-6">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted pointer-events-none"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks by title, description, or key (e.g. CP-12)..."
            className="w-full bg-bg-input border border-border rounded-lg pl-10 pr-4 py-2.5
              text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </form>

      {loading && (
        <div className="flex justify-center py-8">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
        </div>
      )}

      {!loading && searched && results.length === 0 && (
        <p className="text-center text-text-muted py-8">No tasks found</p>
      )}

      {!loading && grouped.map((group) => (
        <div key={group.projectId} className="mb-6">
          <h2 className="text-sm font-semibold text-text-muted mb-2">
            {group.projectName}{" "}
            <span className="font-mono text-xs">({group.projectKey})</span>
          </h2>
          <div className="border border-border rounded-lg overflow-hidden">
            {group.tasks.map((task, i) => (
              <div
                key={task._id}
                onClick={() => router.push(`/projects/${group.projectId}/tasks/${task._id}`)}
                className={`flex items-center gap-3 px-4 py-3 hover:bg-bg-input/50 cursor-pointer transition-colors
                  ${i > 0 ? "border-t border-border" : ""}`}
              >
                <span className="text-xs font-mono text-text-muted whitespace-nowrap">
                  {group.projectKey}-{task.taskNumber}
                </span>
                <span className="text-sm font-medium truncate flex-1">
                  {task.title}
                </span>
                <Badge variant="status" value={task.status}>
                  {STATUS_LABELS[task.status]}
                </Badge>
                <Badge variant="difficulty" value={task.difficulty}>
                  {task.difficulty}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
      </div>
    }>
      <SearchContent />
    </Suspense>
  );
}
