"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export interface DirtyGroup {
  id: string;
  section: string;
  label: string;
  count: number;
  save: () => Promise<void>;
  discard: () => void;
}

interface SettingsContextValue {
  register: (group: DirtyGroup) => void;
  unregister: (id: string) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useDirtyRegistry() {
  const [groups, setGroups] = useState<Record<string, DirtyGroup>>({});

  const register = useCallback((group: DirtyGroup) => {
    setGroups((prev) => ({ ...prev, [group.id]: group }));
  }, []);

  const unregister = useCallback((id: string) => {
    setGroups((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const pending = Object.values(groups).filter((g) => g.count > 0);
  const total = pending.reduce((sum, g) => sum + g.count, 0);

  return { register, unregister, pending, total };
}

export function SettingsProvider({
  register,
  unregister,
  children,
}: SettingsContextValue & { children: React.ReactNode }) {
  const [value] = useState(() => ({ register, unregister }));
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useDirtyGroup(
  group: Omit<DirtyGroup, "save" | "discard">,
  handlers: { save: () => Promise<void>; discard: () => void }
) {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useDirtyGroup must be used inside SettingsProvider");
  const { register, unregister } = ctx;

  const latest = useRef(handlers);
  latest.current = handlers;

  const { id, section, label, count } = group;

  useEffect(() => {
    register({
      id,
      section,
      label,
      count,
      save: () => latest.current.save(),
      discard: () => latest.current.discard(),
    });
    return () => unregister(id);
  }, [id, section, label, count, register, unregister]);
}
