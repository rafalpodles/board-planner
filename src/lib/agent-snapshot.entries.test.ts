import { describe, it, expect, vi, beforeEach } from "vitest";

const agentFindById = vi.fn();
const blockFind = vi.fn();
const projectFindById = vi.fn();

vi.mock("@/models/agent", () => ({ Agent: { findById: (...a: unknown[]) => agentFindById(...a) } }));
vi.mock("@/models/agentBlock", () => ({ AgentBlock: { find: (...a: unknown[]) => blockFind(...a) } }));
vi.mock("@/models/project", () => ({ Project: { findById: (...a: unknown[]) => projectFindById(...a) } }));

const { snapshotFor } = await import("./agent-snapshot");

const lean = <T,>(value: T) => ({ lean: () => Promise.resolve(value) });

const BLOCKS = [
  { key: "diff-size", kind: "gate", name: "Size", gateKind: "diff-size", params: { maxLines: "400", maxFiles: "10" } },
  { key: "implement", kind: "step", name: "Implement", prompt: "do it", capability: "edit", model: "opus", fallbackModel: "sonnet", deterministic: false },
];

beforeEach(() => {
  agentFindById.mockReset();
  blockFind.mockReset();
  projectFindById.mockReset();
  blockFind.mockReturnValue(lean(BLOCKS));
});

describe("snapshotFor with composition entries", () => {
  it("lets a position override the block's parameters, keeping the rest", async () => {
    agentFindById.mockReturnValue(
      lean({
        _id: "a1",
        name: "Strict",
        scope: "global",
        composition: {
          implementation: [{ key: "implement" }],
          verification: [{ key: "diff-size", params: { maxLines: "50" } }],
        },
      })
    );
    const snapshot = await snapshotFor("p1", "a1");
    // maxLines overridden here, maxFiles still the block's
    expect(snapshot?.sequence[1].params).toEqual({ maxLines: "50", maxFiles: "10" });
  });

  it("carries the same block twice with different parameters", async () => {
    agentFindById.mockReturnValue(
      lean({
        _id: "a1",
        name: "Two limits",
        scope: "global",
        composition: {
          verification: [
            { key: "diff-size", params: { maxLines: "50" } },
            { key: "diff-size", params: { maxLines: "5000" } },
          ],
        },
      })
    );
    const snapshot = await snapshotFor("p1", "a1");
    expect(snapshot?.sequence.map((e) => e.params?.maxLines)).toEqual(["50", "5000"]);
  });

  // Nothing needs migrating: a composition written as bare keys still resolves
  it("resolves a composition stored before entries existed", async () => {
    agentFindById.mockReturnValue(
      lean({ _id: "a1", name: "Old", scope: "global", composition: { implementation: ["implement"] } })
    );
    const snapshot = await snapshotFor("p1", "a1");
    expect(snapshot?.sequence.map((e) => e.key)).toEqual(["implement"]);
  });
});
