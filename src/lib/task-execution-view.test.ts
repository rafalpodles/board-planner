import { describe, it, expect, vi } from "vitest";

vi.mock("@/models/worker", () => ({ Worker: { find: () => ({ select: () => ({ lean: async () => [] }) }) } }));
vi.mock("@/lib/task-service", () => ({ toApiExecution: () => undefined }));

const { withApiExecution } = await import("./task-execution-view");

/**
 * BP-381. Every writer that echoes a task back goes through here — the status route, the task PUT,
 * the release. A refused change carries the whole patch, and `patchSha256` and the settlement
 * attempt count are the machine's own bookkeeping; `toApiDecision` exists precisely to withhold
 * them, and this path does not go through it.
 *
 * The schema deselects the heavy fields, so nothing reaches here by accident — but a caller that
 * asked for them (the task-detail GET does) must not have them travel onward through a writer.
 */
describe("the shape a task is published in", () => {
  it("does not publish a refused change from a writer's echo", async () => {
    const published = await withApiExecution({
      _id: "t1",
      title: "x",
      decision: { gate: "protected-paths", patch: "SECRET", patchSha256: "b".repeat(64) },
    } as never);

    expect(published.decision).toBeUndefined();
    expect(JSON.stringify(published)).not.toContain("SECRET");
  });

  // The control: everything else still comes back, or the writers answer with nothing
  it("still publishes the rest of the task", async () => {
    const published = await withApiExecution({ _id: "t1", title: "Add a thing" } as never);

    expect(published).toMatchObject({ _id: "t1", title: "Add a thing" });
  });
});
