"use client";

import { useEffect } from "react";

export function usePollWhileVisible(
  callback: () => void,
  intervalMs: number,
  enabled: boolean = true
) {
  useEffect(() => {
    if (!enabled) return;

    let interval: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (!interval) interval = setInterval(callback, intervalMs);
    };
    const stop = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        callback();
        start();
      } else {
        stop();
      }
    };

    callback();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [callback, intervalMs, enabled]);
}
