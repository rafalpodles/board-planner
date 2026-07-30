"use client";

import { useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";

interface Branch {
  name: string;
  url: string;
  lastCommitAt: string | null;
}

interface Commit {
  shortId: string;
  title: string;
  authorName: string;
  url: string;
  createdAt: string | null;
}

export function GitlabActivity({ projectId, taskId }: { projectId: string; taskId: string }) {
  const api = useApi();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get(`/api/projects/${projectId}/tasks/${taskId}/gitlab-activity`)
      .then((res) => {
        setConfigured(res.configured);
        setBranches(res.branches || []);
        setCommits(res.commits || []);
        if (res.partialError) setError(res.partialError);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load GitLab activity"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, taskId]);

  if (loading || (!configured && !error)) return null;
  if (!error && branches.length === 0 && commits.length === 0) return null;

  return (
    <div>
      <h2 className="font-semibold mb-2">GitLab activity</h2>
      {error && <p className="text-xs text-danger mb-2">{error}</p>}

      {branches.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-text-muted mb-1">Branches ({branches.length})</p>
          <div className="space-y-1">
            {branches.map((b) => (
              <a
                key={b.name}
                href={b.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm hover:bg-bg-hover px-2 py-1.5 rounded transition-colors"
              >
                <svg className="w-4 h-4 shrink-0 text-[#fc6d26]" fill="currentColor" viewBox="0 0 16 16">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
                </svg>
                <span className="flex-1 truncate font-mono text-xs">{b.name}</span>
                {b.lastCommitAt && (
                  <span className="text-[10px] text-text-muted whitespace-nowrap">
                    {new Date(b.lastCommitAt).toLocaleDateString()}
                  </span>
                )}
              </a>
            ))}
          </div>
        </div>
      )}

      {commits.length > 0 && (
        <div>
          <p className="text-xs text-text-muted mb-1">Commits ({commits.length})</p>
          <div className="space-y-1">
            {commits.map((c) => (
              <a
                key={c.shortId}
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm hover:bg-bg-hover px-2 py-1.5 rounded transition-colors"
              >
                <span className="font-mono text-xs text-text-muted shrink-0">{c.shortId}</span>
                <span className="flex-1 truncate">{c.title}</span>
                <span className="text-[10px] text-text-muted whitespace-nowrap">{c.authorName}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
