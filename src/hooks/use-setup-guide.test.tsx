// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import type { ApiSetupGuide } from "@/types";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api, API_WRITE_EVENT: "bp:api-write" }));
vi.mock("@/hooks/use-poll-while-visible", () => ({ usePollWhileVisible: vi.fn() }));

const { useSetupGuide } = await import("./use-setup-guide");

const answer = (done: number): ApiSetupGuide => ({
  show: true,
  steps: [
    { id: "tasks", group: "board", done: done > 0, locked: false },
    { id: "team", group: "board", done: done > 1, locked: false },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(answer(0));
  api.put.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSetupGuide", () => {
  it("reads the guide of the board in the address", async () => {
    const { result } = renderHook(() => useSetupGuide("ORB", "/projects/ORB", true));

    await waitFor(() => expect(result.current.guide).not.toBeNull());
    expect(api.get).toHaveBeenCalledWith("/api/projects/ORB/setup-guide");
  });

  it("reads nothing when there is no board in the address, or the reader is not signed in", () => {
    renderHook(() => useSetupGuide(undefined, "/projects", true));
    renderHook(() => useSetupGuide("ORB", "/projects/ORB", false));

    expect(api.get).not.toHaveBeenCalled();
  });

  it("shows nothing when the server says there is nothing to show", async () => {
    api.get.mockResolvedValue({ show: false, steps: [] });
    const { result } = renderHook(() => useSetupGuide("ORB", "/projects/ORB", true));

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.guide).toBeNull();
  });

  it("reads again when the reader moves to another page", async () => {
    const { rerender } = renderHook(({ path }) => useSetupGuide("ORB", path, true), {
      initialProps: { path: "/projects/ORB" },
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    rerender({ path: "/projects/ORB/settings" });

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it("reads again just after a write lands, and only once for a burst of them", async () => {
    renderHook(() => useSetupGuide("ORB", "/projects/ORB", true));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();

    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new CustomEvent("bp:api-write", { detail: { url: "/api/projects/p/tasks" } }));
    }
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("does not read again for its own write", async () => {
    renderHook(() => useSetupGuide("ORB", "/projects/ORB", true));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();

    window.dispatchEvent(new CustomEvent("bp:api-write", { detail: { url: "/api/projects/ORB/setup-guide" } }));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("stops reading once there is nothing to show, for a reader who is not shown one", async () => {
    api.get.mockResolvedValue({ show: false, steps: [] });
    renderHook(() => useSetupGuide("ORB", "/projects/ORB", true));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    await act(async () => {});
    vi.useFakeTimers();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    window.dispatchEvent(new CustomEvent("bp:api-write", { detail: { url: "/api/projects/p/tasks" } }));
    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.put).not.toHaveBeenCalled();
  });

  it("does not keep a finish when a step in it is locked by somebody else, so lifting the lock brings the rest back", async () => {
    api.get.mockResolvedValue({
      show: false,
      steps: [
        { id: "tasks", group: "board", done: true, locked: false },
        { id: "runs", group: "agents", done: false, locked: true },
      ],
    });
    renderHook(() => useSetupGuide("ORB", "/projects/ORB", true));

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(api.put).not.toHaveBeenCalled();
  });

  it("keeps a finished guide finished: a machine going quiet overnight does not bring it back", async () => {
    api.get.mockResolvedValue({ show: false, steps: answer(2).steps });
    renderHook(() => useSetupGuide("ORB", "/projects/ORB", true));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/projects/ORB/setup-guide", { body: {} }));
    await act(async () => {});
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {});

    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("reads a board it has just been moved to once, though its address changed too", async () => {
    const { rerender } = renderHook(({ ref, path }) => useSetupGuide(ref, path, true), {
      initialProps: { ref: "ORB", path: "/projects/ORB" },
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    rerender({ ref: "NOV", path: "/projects/NOV" });
    await act(async () => {});

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get).toHaveBeenLastCalledWith("/api/projects/NOV/setup-guide");
  });

  it("hides at once, and an answer that was already on its way does not bring it back", async () => {
    let late: (value: ApiSetupGuide) => void = () => undefined;
    const { result } = renderHook(() => useSetupGuide("ORB", "/projects/ORB", true));
    await waitFor(() => expect(result.current.guide).not.toBeNull());
    api.get.mockReturnValueOnce(new Promise<ApiSetupGuide>((resolve) => (late = resolve)));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await act(async () => {
      await result.current.hide();
    });
    expect(result.current.guide).toBeNull();
    expect(api.put).toHaveBeenCalledWith("/api/projects/ORB/setup-guide", { body: {} });

    await act(async () => {
      late(answer(1));
    });
    expect(result.current.guide).toBeNull();
  });

  it("reads again when hiding is refused, so the screen does not claim it was saved", async () => {
    api.put.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useSetupGuide("ORB", "/projects/ORB", true));
    await waitFor(() => expect(result.current.guide).not.toBeNull());
    api.get.mockClear();

    await act(async () => {
      await result.current.hide();
    });

    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
