"use client";

import { useCallback, useEffect, useState } from "react";
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

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.get("/api/agents"), api.get("/api/agent-blocks")]);
      setAgents(Array.isArray(a) ? (a as ApiAgent[]) : []);
      setBlocks(Array.isArray(b) ? (b as ApiAgentBlock[]) : []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    loading,
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

    reload: load,
  };
}
