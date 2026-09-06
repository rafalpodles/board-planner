"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { AgentComposition, ApiAgent, ApiAgentBlock } from "@/types";

export interface NewAgent {
  name: string;
  description: string;
  projectId?: string;
}

export interface NewBlock {
  kind: "step" | "gate";
  name: string;
  description: string;
  gateKind?: string;
  params?: Record<string, string>;
  prompt?: string;
  capability?: string;
  model?: string;
}

export function useStore() {
  const api = useApi();
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [blocks, setBlocks] = useState<ApiAgentBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    // Every mutation reloads, so two reads are routinely in flight. Without the sequence a slow
    // rejection lands after a newer success and hangs a "may be out of date" banner over current
    // data, and a slow success overwrites newer rows while clearing the banner that said so.
    const seq = ++loadSeq.current;
    setRefreshing(true);
    try {
      const [a, b] = await Promise.all([api.get("/api/agents"), api.get("/api/agent-blocks")]);
      if (seq !== loadSeq.current) return;
      setAgents(Array.isArray(a) ? (a as ApiAgent[]) : []);
      setBlocks(Array.isArray(b) ? (b as ApiAgentBlock[]) : []);
      // Cleared by an answer, not by the click: clearing it up front unmounted the banner that
      // was about to say "Retrying…", so the screen went quiet and the failure came back later
      setFailed(false);
    } catch {
      // Without this the rejection went unhandled and the catalog rendered as empty — on the
      // agent screen that reads as deleted rather than as unread (BP-577)
      if (seq === loadSeq.current) setFailed(true);
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    loading,
    failed,
    refreshing,
    allAgents: agents,
    allSteps: blocks.filter((b) => b.kind === "step"),
    allGates: blocks.filter((b) => b.kind === "gate"),

    addAgent: async (agent: NewAgent) => {
      await api.post("/api/agents", agent);
      await load();
    },

    addBlock: async (block: NewBlock) => {
      await api.post("/api/agent-blocks", block);
      await load();
    },

    saveComposition: async (agentId: string, composition: AgentComposition) => {
      await api.put(`/api/agents/${agentId}`, { composition });
      await load();
    },

    updateBlock: async (blockId: string, patch: Partial<NewBlock>) => {
      await api.put(`/api/agent-blocks/${blockId}`, patch);
      await load();
    },

    removeAgent: async (agentId: string) => {
      await api.del(`/api/agents/${agentId}`);
      await load();
    },

    removeBlock: async (blockId: string) => {
      await api.del(`/api/agent-blocks/${blockId}`);
      await load();
    },

    renameAgent: async (agentId: string, name: string, description: string) => {
      await api.put(`/api/agents/${agentId}`, { name, description });
      await load();
    },

    reload: load,

    // Only a retry has nothing to show while it runs; a mutation's reload leaves the catalog
    // where it is
    retry: () => {
      setLoading(true);
      return load();
    },
  };
}
