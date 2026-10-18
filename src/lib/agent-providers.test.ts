import { describe, it, expect, vi } from "vitest";
import { agentsBeyond, agentsNamingAny, canRun, gateProvider, lackedBy, providersOf } from "./agent-providers";
import type { ScopedDb } from "@/lib/db-scope";
import type { SnapshotEntry } from "./agent-snapshot";

const step = (provider?: "claude" | "codex"): SnapshotEntry => ({ key: "s", kind: "step", name: "S", ...(provider ? { provider } : {}) });
const gate = (params: Record<string, string> = {}): SnapshotEntry => ({ key: "g", kind: "gate", name: "G", gateKind: "review", params });

describe("canRun", () => {
  it("lets every machine run Claude Code, with no report", () => {
    expect(canRun([], "claude")).toBe(true);
  });

  it("lets a machine run Codex only when it says so", () => {
    expect(canRun([], "codex")).toBe(false);
    expect(canRun(["multi-repository"], "codex")).toBe(false);
    expect(canRun(["agent-codex"], "codex")).toBe(true);
  });
});

describe("what a sequence needs", () => {
  it("reads a step with no provider as Claude, the way a block stored before BP-987 is", () => {
    expect(providersOf([step()])).toEqual(["claude"]);
  });

  it("reads a review gate's provider, and a gate that names none as Claude", () => {
    expect(gateProvider({ provider: "codex" })).toBe("codex");
    expect(gateProvider({})).toBe("claude");
    expect(gateProvider(undefined)).toBe("claude");
    expect(gateProvider({ provider: "cursor" })).toBe("claude");
  });

  it("names the first provider a machine lacks, and nothing when it lacks none", () => {
    expect(lackedBy([step("claude"), step("codex")], [])).toBe("codex");
    expect(lackedBy([step("claude"), gate({ provider: "codex" })], [])).toBe("codex");
    expect(lackedBy([step("claude"), step("codex")], ["agent-codex"])).toBeNull();
    expect(lackedBy([step(), gate()], [])).toBeNull();
  });
});

describe("agentsBeyond", () => {
  function dbWith(blocks: { key: string }[], agents: { _id: string }[]) {
    const blockFind = vi.fn((..._args: unknown[]) => ({ lean: async () => blocks }));
    const agentFind = vi.fn((..._args: unknown[]) => ({ lean: async () => agents }));
    return { db: { AgentBlock: { find: blockFind }, Agent: { find: agentFind } } as unknown as ScopedDb, blockFind, agentFind };
  }

  it("asks nothing of the database for a machine that can run everything", async () => {
    const { db, blockFind, agentFind } = dbWith([], []);

    expect(await agentsBeyond(db, ["agent-codex"])).toEqual([]);
    expect(blockFind).not.toHaveBeenCalled();
    expect(agentFind).not.toHaveBeenCalled();
  });

  it("returns the agents that use a block on a provider the machine lacks", async () => {
    const { db, blockFind, agentFind } = dbWith([{ key: "on-codex" }], [{ _id: "a1" }, { _id: "a2" }]);

    expect(await agentsBeyond(db, [])).toEqual(["a1", "a2"]);
    expect(blockFind.mock.calls[0][0]).toEqual({ $or: [{ provider: "codex" }, { "params.provider": "codex" }] });
    expect(JSON.stringify(agentFind.mock.calls[0][0])).toContain('"composition.implementation":{"$elemMatch":{"$eq":"on-codex"}}');
  });

  it("does not look at agents at all while no block is on a provider the machine lacks", async () => {
    const { db, agentFind } = dbWith([], [{ _id: "a1" }]);

    expect(await agentsBeyond(db, [])).toEqual([]);
    expect(agentFind).not.toHaveBeenCalled();
  });
});

// A mocked database never casts a filter, which is how a bare string against a subdocument array
// (BP-460) reached review: the real model is asked here
describe("the filter agentsBeyond sends is one the Agent model can cast", () => {
  it("casts, in either stored shape of a composition", async () => {
    const { Agent } = await import("@/models/agent");

    expect(() => Agent.find(agentsNamingAny(["implement", "other"])).cast(Agent)).not.toThrow();
  });

  it("and the shape it replaced did not, which is what makes the test above able to fail", async () => {
    const { Agent } = await import("@/models/agent");

    expect(() => Agent.find({ "composition.delivery": { $in: ["implement"] } } as never).cast(Agent)).toThrow(/Cast to embedded failed/);
  });
});
