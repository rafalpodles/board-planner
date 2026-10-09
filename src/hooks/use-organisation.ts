"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useApi } from "./use-api";
import { useAuth } from "./use-auth";

export interface OrganisationSummary {
  name: string;
  named: boolean;
  cloud: boolean;
  address: string | null;
  plan: "free" | "pro";
  planEndsAt: string | null;
  trial?: boolean;
  subscription?: "renewing" | "ending" | null;
  members?: number;
  memberLimit?: number | null;
  invited?: number;
  projects?: number;
}

type Snapshot = { summary: OrganisationSummary | null; failed: boolean; forUser: string | null };

let snapshot: Snapshot = { summary: null, failed: false, forUser: null };
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useOrganisation() {
  const api = useApi();
  const { user } = useAuth();
  const userId = user?._id ?? null;
  const current = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

  const reload = useCallback(async () => {
    let next: Snapshot;
    try {
      next = { summary: await api.get("/api/organisation"), failed: false, forUser: userId };
    } catch {
      next = { summary: null, failed: true, forUser: userId };
    }
    if (snapshot.forUser === userId) publish(next);
  }, [api, userId]);

  useEffect(() => {
    if (userId && snapshot.forUser !== userId) {
      publish({ summary: null, failed: false, forUser: userId });
      void reload();
    }
  }, [userId, reload]);

  const rename = useCallback(
    async (name: string) => {
      const summary = await api.put("/api/organisation", { name });
      if (snapshot.forUser === userId) publish({ summary, failed: false, forUser: userId });
    },
    [api, userId]
  );

  const mine = current.forUser === userId;
  return { organisation: mine ? current.summary : null, failed: mine && current.failed, reload, rename };
}
