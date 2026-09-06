"use client";

import { useEffect } from "react";
import { useParams, usePathname } from "next/navigation";
import { isObjectIdSegment } from "@/lib/urls";

export function useCanonicalUrl(projectKey?: string, taskNumber?: number) {
  const { projectId, taskId } = useParams<{ projectId: string; taskId?: string }>();
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    let canonical = pathname;
    if (projectKey && isObjectIdSegment(projectId)) {
      canonical = canonical.replace(`/projects/${projectId}`, `/projects/${projectKey}`);
    }
    if (taskNumber !== undefined && taskId && isObjectIdSegment(taskId)) {
      canonical = canonical.replace(`/tasks/${taskId}`, `/tasks/${taskNumber}`);
    }
    if (canonical === pathname) return;
    window.history.replaceState(null, "", canonical + window.location.search + window.location.hash);
  }, [pathname, projectId, projectKey, taskId, taskNumber]);
}
