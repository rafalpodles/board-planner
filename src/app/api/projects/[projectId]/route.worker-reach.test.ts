import { describe, it, expect, vi } from "vitest";

const declared: Array<{ options: unknown }> = [];

vi.mock("@/lib/middleware", () => ({
  withProjectAccess: (handler: unknown) => handler,
  withProjectOwner: (handler: unknown) => handler,
  withProjectAccessOrWorker: (handler: unknown, options?: unknown) => {
    declared.push({ options });
    return handler;
  },
}));

await import("./route");

// BP-758: a run reads the board's columns from this route, and a machine the project stopped
// serving mid-run reaches it only through the reach it declares — the task routes do not reach a
// route that names no task
describe("GET /api/projects/[projectId] as a worker", () => {
  it("is the board read a held run may make", () => {
    expect(declared).toEqual([{ options: { reach: "board" } }]);
  });
});
