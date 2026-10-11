"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_WRITE_EVENT, useApi } from "@/hooks/use-api";
import { usePollWhileVisible } from "@/hooks/use-poll-while-visible";
import type { ApiSetupGuide } from "@/types";

const POLL_MS = 60_000;
const WRITE_SETTLE_MS = 600;

export function useSetupGuide(projectRef: string | undefined, pathname: string, enabled: boolean) {
  const api = useApi();
  const [guide, setGuide] = useState<ApiSetupGuide | null>(null);
  const reads = useRef({ issued: 0, hiddenAfter: 0 });

  const load = useCallback(() => {
    if (!projectRef) return;
    const read = ++reads.current.issued;
    api
      .get(`/api/projects/${projectRef}/setup-guide`)
      .then((body: ApiSetupGuide) => {
        // A read begun before Hide may answer after it with the guide still shown
        if (read > reads.current.hiddenAfter) setGuide(body);
      })
      .catch(() => {
        if (read > reads.current.hiddenAfter) setGuide(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRef]);

  useEffect(() => {
    reads.current.hiddenAfter = reads.current.issued;
    setGuide(null);
    if (!enabled || !projectRef) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRef, enabled]);

  // A step is taken somewhere else, so the answer is read again on every move and on coming back
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (firstPath.current === pathname) return;
    firstPath.current = pathname;
    if (enabled && projectRef) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [enabled, load]);

  // A step is usually taken by a write, so the answer is read again just after one lands
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onWrite = (e: Event) => {
      const url = String((e as CustomEvent<{ url?: string }>).detail?.url ?? "");
      if (url.endsWith("/setup-guide")) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, WRITE_SETTLE_MS);
    };
    window.addEventListener(API_WRITE_EVENT, onWrite);
    return () => {
      window.removeEventListener(API_WRITE_EVENT, onWrite);
      if (timer) clearTimeout(timer);
    };
  }, [enabled, load]);

  usePollWhileVisible(load, POLL_MS, enabled && !!projectRef);

  const hide = useCallback(async () => {
    if (!projectRef) return;
    reads.current.hiddenAfter = reads.current.issued;
    setGuide(null);
    try {
      await api.put(`/api/projects/${projectRef}/setup-guide`, { body: {} });
    } catch {
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRef, load]);

  return { guide: guide?.show ? guide : null, hide };
}
