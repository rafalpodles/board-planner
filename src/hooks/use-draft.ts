"use client";

import { useCallback, useMemo, useState } from "react";

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

export function useDraft<T extends Record<string, unknown>>(initial: T) {
  const [baseline, setBaseline] = useState<T>(initial);
  const [value, setValue] = useState<T>(initial);

  const set = useCallback(<K extends keyof T>(key: K, next: T[K]) => {
    setValue((prev) => ({ ...prev, [key]: next }));
  }, []);

  const dirtyKeys = useMemo(
    () => (Object.keys(value) as (keyof T)[]).filter((k) => !same(value[k], baseline[k])),
    [value, baseline]
  );

  const isDirty = useCallback((key: keyof T) => dirtyKeys.includes(key), [dirtyKeys]);

  const discard = useCallback(() => setValue(baseline), [baseline]);

  const commit = useCallback((next: T) => {
    setBaseline(next);
    setValue(next);
  }, []);

  const rebase = useCallback((next: T) => setBaseline(next), []);

  return {
    value,
    baseline,
    set,
    setValue,
    dirtyKeys,
    count: dirtyKeys.length,
    isDirty,
    discard,
    commit,
    rebase,
  };
}
