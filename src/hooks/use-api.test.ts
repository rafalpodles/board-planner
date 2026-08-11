// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useApi } from "./use-api";

const onUnauthorized = vi.fn();
vi.mock("./use-auth", () => ({ useAuth: () => ({ onUnauthorized }) }));

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
