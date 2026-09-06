"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApi } from "@/hooks/use-api";
import { openLayerCount, subscribeLayers } from "@/lib/focus-trap";
import { isPmRunnable } from "@/lib/pm/gate";
import { projectRefFromPathname } from "@/lib/urls";
import { ApiProject } from "@/types";
import { PmChat } from "./PmChat";

export function PmChatWidget() {
  const pathname = usePathname();
  const api = useApi();

  const projectId = projectRefFromPathname(pathname);
  const onPmPage = !!pathname && /\/pm\/?$/.test(pathname);

  const [project, setProject] = useState<ApiProject | null>(null);
  const [open, setOpen] = useState(false);
  // A dialog is a bottom sheet on a phone, and this button is painted at the same z-50 over its
  // action row: on a right-aligned footer it covers the primary button's own corner, so a finger
  // there opens the PM chat instead (BP-589). Server-rendered as 0, which is what no dialog is.
  const layers = useSyncExternalStore(subscribeLayers, openLayerCount, () => 0);

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

  if (!projectId || onPmPage || !project?.pmAvailable || !isPmRunnable(project?.pm)) {
    return null;
  }

  // Its own panel registers no layer, so this only stands aside for somebody else's dialog
  if (layers > 0) return null;

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
        className="fixed bottom-6 right-4 z-50 flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-primary-solid text-white shadow-lg ring-4 ring-primary/20 transition-colors hover:bg-primary-solid-hover"
      >
        {open ? (
          <svg
            className="h-[26px] w-[26px]"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg
            className="h-[26px] w-[26px]"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 7V4M6 7h12a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2zM9 13h.01M15 13h.01"
            />
          </svg>
        )}
      </button>
    </>
  );
}
