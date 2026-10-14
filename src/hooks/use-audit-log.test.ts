// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const api = { get: vi.fn() };
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));

const { useAuditLog } = await import("./use-audit-log");
const { NO_AUDIT_FILTERS } = await import("@/components/audit/AuditFilters");

afterEach(cleanup);

describe("useAuditLog", () => {
  // BP-548: a screen must not claim a failure for a read still in flight
  it("withdraws a failure the moment it reads again", async () => {
    api.get.mockRejectedValueOnce(new Error("down"));
    const { result } = renderHook(() => useAuditLog<{ _id: string }>("/api/admin/audit", 2));
    await act(() => result.current.reload());
    expect(result.current.failed).toBe(true);

    let answer!: (rows: { _id: string }[]) => void;
    api.get.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    act(() => void result.current.apply({ ...NO_AUDIT_FILTERS, action: "user_created" }));
    expect(result.current.failed).toBe(false);
    expect(result.current.rows).toBeNull();

    await act(async () => answer([{ _id: "a" }]));
    expect(result.current.rows).toEqual([{ _id: "a" }]);
    expect(api.get).toHaveBeenLastCalledWith("/api/admin/audit?action=user_created");
  });

  it("continues after the last row it holds, with the filters it was given", async () => {
    api.get.mockResolvedValueOnce([{ _id: "a" }, { _id: "b" }]);
    const { result } = renderHook(() => useAuditLog<{ _id: string }>("/api/admin/audit", 2));
    await act(() => result.current.apply({ ...NO_AUDIT_FILTERS, actor: "rafal" }));
    expect(result.current.more).toBe(true);

    api.get.mockResolvedValueOnce([{ _id: "c" }]);
    await act(() => result.current.loadMore());
    expect(api.get).toHaveBeenLastCalledWith("/api/admin/audit?actor=rafal&before=b");
    expect(result.current.rows?.map((r) => r._id)).toEqual(["a", "b", "c"]);
    expect(result.current.more).toBe(false);
  });
});
