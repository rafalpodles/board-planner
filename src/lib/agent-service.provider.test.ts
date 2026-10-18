import { describe, it, expect } from "vitest";
import { compositionRefusal } from "./agent-service";
import type { ScopedDb } from "@/lib/db-scope";
import type { AgentComposition } from "@/types";

/**
 * BP-987. Whoever may edit an agent is not whoever may choose what runs on a machine, so a position in
 * a composition may tune a gate's parameters and never move it to another coding CLI.
 */
const block = (over: Record<string, unknown>) => ({ _id: over.key, builtIn: false, description: "", prompt: "", capability: "read-only", provider: "claude", model: "", fallbackModel: "", deterministic: false, ...over });
const BLOCKS = [
  block({ key: "implement", kind: "step", name: "Implement", capability: "edit", model: "opus" }),
  block({ key: "claude-review", kind: "gate", name: "Reviewed", gateKind: "review", params: { focus: "general", provider: "claude", model: "opus" } }),
  block({ key: "codex-review", kind: "gate", name: "Reviewed on Codex", gateKind: "review", params: { focus: "general", provider: "codex", model: "gpt-5" } }),
  block({ key: "size", kind: "gate", name: "Size", gateKind: "diff-size", params: { maxLines: "400" } }),
  block({ key: "push", kind: "step", name: "Push", deterministic: true }),
];
const db = { AgentBlock: { find: () => ({ sort: () => ({ lean: async () => BLOCKS }) }) } } as unknown as ScopedDb;

const compose = (verification: unknown[]): AgentComposition =>
  ({ analysis: [], implementation: [{ key: "implement" }], verification, delivery: [{ key: "push" }] }) as AgentComposition;

describe("compositionRefusal and a position's provider", () => {
  it("refuses a position that moves a Claude review to Codex, naming whose choice that is", async () => {
    const refusal = await compositionRefusal(db, compose([{ key: "claude-review", params: { provider: "codex", model: "gpt-5" } }]));

    expect(refusal?.error).toMatch(/Reviewed: a position cannot change what a gate runs on.*admin/);
  });

  it("refuses a position that moves a Codex review back to Claude", async () => {
    const refusal = await compositionRefusal(db, compose([{ key: "codex-review", params: { provider: "claude", model: "opus" } }]));

    expect(refusal?.error).toMatch(/cannot change what a gate runs on/);
  });

  it("takes a position that restates the provider the gate already has", async () => {
    expect(await compositionRefusal(db, compose([{ key: "codex-review", params: { provider: "codex", model: "gpt-6" } }]))).toBeNull();
    expect(await compositionRefusal(db, compose([{ key: "claude-review", params: { provider: "claude" } }]))).toBeNull();
  });

  it("still lets a position tune the model, judged as the pair the worker would be handed", async () => {
    expect(await compositionRefusal(db, compose([{ key: "codex-review", params: { model: "gpt-6" } }]))).toBeNull();
    expect((await compositionRefusal(db, compose([{ key: "codex-review", params: { model: "sonnet" } }])))?.error).toMatch(/Claude model, not a Codex one/);
    expect((await compositionRefusal(db, compose([{ key: "claude-review", params: { model: "gpt-5" } }])))?.error).toMatch(/not a Claude model/);
  });

  it("leaves other gates' positions alone", async () => {
    expect(await compositionRefusal(db, compose([{ key: "size", params: { maxLines: "50" } }]))).toBeNull();
  });
});
