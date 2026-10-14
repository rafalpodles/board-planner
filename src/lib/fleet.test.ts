import { describe, it, expect, vi, beforeEach } from "vitest";
import { QUIET_MS } from "./run-state";

const check = vi.fn();
vi.mock("@/lib/grants", () => ({ check: (...a: unknown[]) => check(...a) }));
vi.mock("@/lib/machine-limit", () => ({ claimingMachineIds: async () => null, isHeldByPlan: () => false }));

const { fleetFor, fleetState } = await import("./fleet");

const ME = { _id: "u1", role: "member" } as never;
const ADMIN = { _id: "a1", role: "admin" } as never;
const seen = () => new Date(Date.now() - 1_000);

let workerFilter: unknown;
function dbWith(workers: Record<string, unknown>[], tasks: Record<string, unknown>[]) {
  return {
    Worker: {
      find: (filter: unknown) => {
        workerFilter = filter;
        return { sort: () => ({ lean: async () => workers }) };
      },
    },
    Task: {
      find: () => {
        const chain = { sort: () => chain, select: () => chain, populate: () => chain, lean: async () => tasks };
        return chain;
      },
    },
  } as never;
}

const worker = (over: Record<string, unknown> = {}) => ({ _id: "w1", name: "rpo-mbp", enabled: true, lastSeenAt: seen(), ...over });
const held = (over: Record<string, unknown> = {}) => ({
  _id: "t1",
  taskNumber: 7,
  title: "Ship it",
  project: { _id: "p1", key: "BP" },
  execution: { workerId: "w1", runId: "r1", phase: "agent", phaseAt: new Date(), startedAt: new Date() },
  ...over,
});

beforeEach(() => {
  check.mockReset();
  check.mockResolvedValue(true);
});

describe("fleetFor", () => {
  it("names the task a working machine holds and its phase", async () => {
    expect(await fleetFor(dbWith([worker()], [held()]), ME)).toEqual([
      { _id: "w1", name: "rpo-mbp", state: "running", task: { key: "BP-7", title: "Ship it", phase: "agent", projectKey: "BP", taskNumber: 7 } },
    ]);
  });

  it("calls a run quiet by the board's own rule", async () => {
    const silent = new Date(Date.now() - QUIET_MS - 60_000);
    const [row] = await fleetFor(
      dbWith([worker()], [held({ execution: { workerId: "w1", runId: "r1", phaseAt: silent, startedAt: silent } })]),
      ME
    );
    expect(row.state).toBe("quiet");
  });

  it("calls a live machine holding nothing idle, and a silent one offline", async () => {
    const rows = await fleetFor(
      dbWith([worker(), worker({ _id: "w2", name: "old", lastSeenAt: new Date(Date.now() - 3_600_000) })], []),
      ME
    );
    expect(rows.map((r) => [r.name, r.state, r.task])).toEqual([
      ["rpo-mbp", "idle", undefined],
      ["old", "offline", undefined],
    ]);
  });

  it("never names a task on a project the reader cannot open", async () => {
    check.mockResolvedValue(false);
    const [row] = await fleetFor(dbWith([worker()], [held()]), ME);
    expect(row).toEqual({ _id: "w1", name: "rpo-mbp", state: "running", task: { hidden: true } });
    expect(JSON.stringify(row)).not.toMatch(/BP-7|Ship it/);
    expect(check).toHaveBeenCalledWith(expect.anything(), ME, "p1", "access");
  });

  it("shows a person their own machines and an administrator every one", async () => {
    await fleetFor(dbWith([], []), ME);
    expect(workerFilter).toEqual({ owner: "u1" });
    await fleetFor(dbWith([], []), ADMIN);
    expect(workerFilter).toEqual({});
  });
});

describe("fleetState", () => {
  it("does not call a switched-off or silent machine working, whatever it last held", () => {
    expect(fleetState("disabled", held() as never)).toBe("off");
    expect(fleetState("stale", held() as never)).toBe("offline");
    expect(fleetState("paused", undefined)).toBe("paused");
    expect(fleetState("live", undefined)).toBe("idle");
  });
});
