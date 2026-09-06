// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useApi } from "./use-api";

const onUnauthorized = vi.fn();
const noteApiStatus = vi.fn();
vi.mock("./use-auth", () => ({ useAuth: () => ({ onUnauthorized, noteApiStatus }) }));

function response(status: number, statusText: string, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as Response;
}

beforeEach(() => {
  onUnauthorized.mockClear();
  noteApiStatus.mockClear();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useApi request error extraction", () => {
  it("throws the server's error message for a non-2xx response with a parseable body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(409, "Conflict", { error: "A board must keep at least one owner" })
    );
    const { result } = renderHook(() => useApi());

    await expect(result.current.get("/api/x")).rejects.toThrow(
      "A board must keep at least one owner"
    );
  });

  it("falls back to statusText when the body cannot be parsed", async () => {
    vi.mocked(fetch).mockResolvedValue(response(500, "Internal Server Error"));
    const { result } = renderHook(() => useApi());

    await expect(result.current.get("/api/x")).rejects.toThrow("Internal Server Error");
  });
});

describe("useApi dead session", () => {
  it("reports a 401 to the auth context so the guard can redirect", async () => {
    vi.mocked(fetch).mockResolvedValue(response(401, "Unauthorized", { error: "Unauthorized" }));
    const { result } = renderHook(() => useApi());

    await expect(result.current.get("/api/x")).rejects.toThrow("Unauthorized");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("reports a 401 from upload and from stream", async () => {
    vi.mocked(fetch).mockResolvedValue(response(401, "Unauthorized", { error: "Unauthorized" }));
    const { result } = renderHook(() => useApi());

    await expect(result.current.upload("/api/uploads", new FormData())).rejects.toThrow(
      "Unauthorized"
    );
    await result.current.stream("/api/pm/chat", {});

    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it("leaves the session alone on a 403 provenance refusal", async () => {
    vi.mocked(fetch).mockResolvedValue(response(403, "Forbidden", { error: "Forbidden" }));
    const { result } = renderHook(() => useApi());

    await expect(result.current.post("/api/x", {})).rejects.toThrow("Forbidden");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("useApi during an outage", () => {
  const outage = () =>
    response(503, "Service Unavailable", {
      error: "The database is unreachable. This is not a problem with your session.",
    });

  it("does not clear the session on a 503 from get", async () => {
    vi.mocked(fetch).mockResolvedValue(outage());
    const { result } = renderHook(() => useApi());

    await expect(result.current.get("/api/x")).rejects.toThrow(/database is unreachable/i);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("does not clear the session on a 503 from upload", async () => {
    vi.mocked(fetch).mockResolvedValue(outage());
    const { result } = renderHook(() => useApi());

    await expect(result.current.upload("/api/uploads", new FormData())).rejects.toThrow();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("does not clear the session on a 503 from stream", async () => {
    vi.mocked(fetch).mockResolvedValue(outage());
    const { result } = renderHook(() => useApi());

    await result.current.stream("/api/pm/chat", {});
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("does not clear the session on a 500 either", async () => {
    vi.mocked(fetch).mockResolvedValue(response(500, "Internal Server Error"));
    const { result } = renderHook(() => useApi());

    await expect(result.current.get("/api/x")).rejects.toThrow();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("reports every status to the auth context, so the shell can say what is happening", async () => {
    vi.mocked(fetch).mockResolvedValue(outage());
    const { result } = renderHook(() => useApi());

    await expect(result.current.get("/api/x")).rejects.toThrow();
    expect(noteApiStatus).toHaveBeenCalledWith(503);

    vi.mocked(fetch).mockResolvedValue(response(200, "OK", { ok: true }));
    await result.current.get("/api/x");
    expect(noteApiStatus).toHaveBeenLastCalledWith(200);
  });

  it("reports the status from upload and stream too", async () => {
    vi.mocked(fetch).mockResolvedValue(outage());
    const { result } = renderHook(() => useApi());

    await expect(result.current.upload("/api/uploads", new FormData())).rejects.toThrow();
    await result.current.stream("/api/pm/chat", {});

    expect(noteApiStatus.mock.calls).toEqual([[503], [503]]);
  });
});

