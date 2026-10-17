import { describe, it, expect, vi, beforeEach } from "vitest";

const agentFindOne = vi.fn();
const blockFind = vi.fn();
const projectFindOne = vi.fn();

vi.mock("@/models/agent", () => ({ Agent: { findOne: (...a: unknown[]) => agentFindOne(...a) } }));
vi.mock("@/models/agentBlock", () => ({ AgentBlock: { find: (...a: unknown[]) => blockFind(...a) } }));
vi.mock("@/models/project", () => ({ Project: { findOne: (...a: unknown[]) => projectFindOne(...a) } }));

const { snapshotFor } = await import("./agent-snapshot");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

// Every agent here is global, so whose machine is asking cannot be what these tests are about
const MACHINE_OWNER = "69a52e3b399b27d3cbb2c5f1";

const lean = <T,>(value: T) => ({ lean: () => Promise.resolve(value) });

const BLOCKS = [
  { key: "diff-size", kind: "gate", name: "Size", gateKind: "diff-size", params: { maxLines: "400", maxFiles: "10" } },
  { key: "implement", kind: "step", name: "Implement", prompt: "do it", capability: "edit", model: "opus", fallbackModel: "sonnet", deterministic: false },
];

beforeEach(() => {
  agentFindOne.mockReset();
  blockFind.mockReset();
  projectFindOne.mockReset();
  blockFind.mockReturnValue(lean(BLOCKS));
});

describe("snapshotFor with composition entries", () => {
  it("lets a position override the block's parameters, keeping the rest", async () => {
    agentFindOne.mockReturnValue(
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
    const snapshot = await snapshotFor(scopedToDefaultOrganisation(), "p1", "a1", MACHINE_OWNER);
    // maxLines overridden here, maxFiles still the block's
    expect(snapshot?.sequence[1].params).toEqual({ maxLines: "50", maxFiles: "10" });
  });

  it("carries the same block twice with different parameters", async () => {
    agentFindOne.mockReturnValue(
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
    const snapshot = await snapshotFor(scopedToDefaultOrganisation(), "p1", "a1", MACHINE_OWNER);
    expect(snapshot?.sequence.map((e) => e.params?.maxLines)).toEqual(["50", "5000"]);
  });

  // Nothing needs migrating: a composition written as bare keys still resolves
  it("resolves a composition stored before entries existed", async () => {
    agentFindOne.mockReturnValue(
      lean({ _id: "a1", name: "Old", scope: "global", composition: { implementation: ["implement"] } })
    );
    const snapshot = await snapshotFor(scopedToDefaultOrganisation(), "p1", "a1", MACHINE_OWNER);
    expect(snapshot?.sequence.map((e) => e.key)).toEqual(["implement"]);
  });
});

describe("snapshotFor and the provider of a step (BP-987)", () => {
  it("carries a step's provider, Claude for a block stored without one", async () => {
    blockFind.mockReturnValue(
      lean([
        { ...BLOCKS[1], key: "on-codex", provider: "codex", model: "gpt-5", fallbackModel: "" },
        { ...BLOCKS[1], key: "old" },
      ])
    );
    agentFindOne.mockReturnValue(
      lean({ _id: "a1", name: "Mixed", scope: "global", composition: { implementation: [{ key: "on-codex" }, { key: "old" }] } })
    );

    const snapshot = await snapshotFor(scopedToDefaultOrganisation(), "p1", "a1", MACHINE_OWNER);

    expect(snapshot?.sequence.map((entry) => entry.provider)).toEqual(["codex", "claude"]);
  });
});
