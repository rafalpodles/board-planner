"use client";

import { useEffect } from "react";
import { useParams, usePathname } from "next/navigation";
import { isObjectIdSegment } from "@/lib/urls";

// Old links carry ObjectIds. Once the readable identifiers are known, swap them
// into the address bar so bookmarks and shared links settle on the canonical URL.
export function useCanonicalUrl(projectKey?: string, taskNumber?: number) {
  const { projectId, taskId } = useParams<{ projectId: string; taskId?: string }>();
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    let canonical = pathname;
    if (projectKey && isObjectIdSegment(projectId)) {
      canonical = canonical.replace(`/projects/${projectId}`, `/projects/${projectKey}`);
    }
    if (taskNumber !== undefined && taskId && taskId !== String(taskNumber)) {
      canonical = canonical.replace(`/tasks/${taskId}`, `/tasks/${taskNumber}`);
    }
    if (canonical === pathname) return;
    // Native, not router.replace: a soft navigation to a task URL wakes the
    // intercepting modal route, which would then render a second copy of the
    // task on top of the page that just rewrote its own address.
    window.history.replaceState(null, "", canonical + window.location.search + window.location.hash);
  }, [pathname, projectId, projectKey, taskId, taskNumber]);
}
