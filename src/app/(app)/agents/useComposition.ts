"use client";

import { useEffect, useRef, useState } from "react";
import { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { AGENT_BUCKETS, AgentBucket, AgentComposition, ApiAgentBlock } from "@/types";
import { BUCKET_PREFIX, Entry, Lookup, NEW_PREFIX } from "./components/blocks";
import { emptyComposition } from "./catalog";

type Entries = Record<AgentBucket, Entry[]>;

let counter = 0;
const nextUid = () => `e${++counter}`;

function toEntries(composition: AgentComposition): Entries {
  const out = {} as Entries;
  for (const bucket of AGENT_BUCKETS) {
    out[bucket] = (composition[bucket] ?? []).map((entry) => ({
      uid: nextUid(),
      key: entry.key,
      params: entry.params,
    }));
  }
  return out;
}

function toComposition(entries: Entries): AgentComposition {
  const out = {} as AgentComposition;
  for (const bucket of AGENT_BUCKETS) {
    out[bucket] = entries[bucket].map((e) => ({ key: e.key, params: e.params }));
  }
  return out;
}

export function useComposition(source: AgentComposition | undefined, lookup: Lookup) {
  const [entries, setEntries] = useState<Entries>(() => toEntries(source ?? emptyComposition()));
  const [dragging, setDragging] = useState<ApiAgentBlock | null>(null);

  const seeded = useRef(false);
  useEffect(() => {
    if (!source || seeded.current) return;
    seeded.current = true;
    setEntries(toEntries(source));
  }, [source]);

  const bucketOf = (uid: string) =>
    AGENT_BUCKETS.find((bucket) => entries[bucket].some((e) => e.uid === uid));

  const keyOf = (uid: string) => {
    for (const bucket of AGENT_BUCKETS) {
      const found = entries[bucket].find((e) => e.uid === uid);
      if (found) return found.key;
    }
    return undefined;
  };

  function resolveTarget(overId: string): { bucket: AgentBucket; index: number } | null {
    if (overId.startsWith(BUCKET_PREFIX)) {
      const bucket = overId.slice(BUCKET_PREFIX.length) as AgentBucket;
      return { bucket, index: entries[bucket].length };
    }
    const bucket = bucketOf(overId);
    if (!bucket) return null;
    return { bucket, index: entries[bucket].findIndex((e) => e.uid === overId) };
  }

  function onDragStart({ active }: DragStartEvent) {
    const id = String(active.id);
    const key = id.startsWith(NEW_PREFIX) ? id.slice(NEW_PREFIX.length) : keyOf(id);
    setDragging(lookup(key ?? "") ?? null);
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setDragging(null);
    if (!over) return;

    const activeId = String(active.id);
    const target = resolveTarget(String(over.id));
    if (!target) return;

    if (activeId.startsWith(NEW_PREFIX)) {
      const key = activeId.slice(NEW_PREFIX.length);
      setEntries((prev) => {
        const next = { ...prev, [target.bucket]: [...prev[target.bucket]] };
        next[target.bucket].splice(target.index, 0, { uid: nextUid(), key });
        return next;
      });
      return;
    }

    const from = bucketOf(activeId);
    if (!from) return;

    setEntries((prev) => {
      const fromIndex = prev[from].findIndex((e) => e.uid === activeId);
      if (from === target.bucket) {
        if (fromIndex === target.index) return prev;
        return { ...prev, [from]: arrayMove(prev[from], fromIndex, target.index) };
      }
      const moved = prev[from][fromIndex];
      const nextTo = [...prev[target.bucket]];
      nextTo.splice(target.index, 0, moved);
      return {
        ...prev,
        [from]: prev[from].filter((e) => e.uid !== activeId),
        [target.bucket]: nextTo,
      };
    });
  }

  function addTo(bucket: AgentBucket, key: string) {
    setEntries((prev) => ({ ...prev, [bucket]: [...prev[bucket], { uid: nextUid(), key }] }));
  }

  function remove(uid: string) {
    setEntries((prev) => {
      const bucket = AGENT_BUCKETS.find((b) => prev[b].some((e) => e.uid === uid));
      if (!bucket) return prev;
      return { ...prev, [bucket]: prev[bucket].filter((e) => e.uid !== uid) };
    });
  }

  return {
    entries,
    dragging,
    composition: toComposition(entries),
    onDragStart,
    onDragEnd,
    addTo,
    remove,
  };
}
