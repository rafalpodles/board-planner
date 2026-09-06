"use client";

import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const GUTTER = 12;

export function usePanelClamp(open: boolean): {
  ref: RefObject<HTMLDivElement | null>;
  style: { transform: string } | undefined;
} {
  const ref = useRef<HTMLDivElement>(null);
  const applied = useRef(0);
  const [shiftX, setShiftX] = useState(0);

  const measure = useCallback(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;

    const left = box.left - applied.current;
    const right = box.right - applied.current;
    const past = right - (window.innerWidth - GUTTER);
    const short = GUTTER - left;
    applied.current = short > 0 ? short : past > 0 ? -past : 0;
    setShiftX(applied.current);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      applied.current = 0;
      setShiftX(0);
      return;
    }
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const anchor = ref.current?.offsetParent;
    const observer = anchor ? new ResizeObserver(measure) : null;
    if (anchor && observer) observer.observe(anchor);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [open, measure]);

  return { ref, style: shiftX ? { transform: `translateX(${shiftX}px)` } : undefined };
}
