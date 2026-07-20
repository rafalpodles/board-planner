"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { ApiProject } from "@/types";
import { PmChat } from "./PmChat";

export function PmChatWidget() {
  const pathname = usePathname();
  const api = useApi();

  const match = pathname?.match(/^\/projects\/([0-9a-f]{24})(\/|$)/);
  const projectId = match?.[1];
  const onPmPage = !!pathname && /\/pm\/?$/.test(pathname);

  const [project, setProject] = useState<ApiProject | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setProject(null);
    setOpen(false);
    if (!projectId) return;
    api
      .get(`/api/projects/${projectId}`)
      .then(setProject)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (!projectId || onPmPage || !project?.pm?.enabled || !project?.pmAvailable) {
    return null;
  }

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-4 z-50 w-[min(30rem,calc(100vw-2rem))] h-[min(44rem,calc(100vh-8rem))] bg-bg border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-card shrink-0">
            <p className="font-semibold text-sm">🤖 PM — {project.name}</p>
            <div className="flex items-center gap-3">
              <Link
                href={`/projects/${projectId}/pm`}
                title="Open full page"
                onClick={() => setOpen(false)}
                className="text-text-muted hover:text-text text-sm"
              >
                ⤢
              </Link>
              <button
                onClick={() => setOpen(false)}
                className="text-text-muted hover:text-text cursor-pointer"
                aria-label="Close PM chat"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <PmChat projectId={projectId} preloadedProject={project} />
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close PM chat" : "Open PM chat"}
        title="PM Agent"
        className="fixed bottom-6 right-4 z-50 w-14 h-14 rounded-full bg-primary text-white shadow-lg hover:opacity-90 cursor-pointer flex items-center justify-center text-2xl"
      >
        {open ? "✕" : "🤖"}
      </button>
    </>
  );
}
