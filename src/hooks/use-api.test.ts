// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useApi } from "./use-api";

vi.mock("./use-auth", () => ({ useAuth: () => ({ getAuthHeader: () => null }) }));

function response(ok: boolean, statusText: string, body?: unknown): Response {
  return {
    ok,
    statusText,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useApi request error extraction", () => {
  it("throws the server's error message for a non-2xx response with a parseable body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(false, "Conflict", { error: "A board must keep at least one owner" })
    );
    const { result } = renderHook(() => useApi());

    await expect(result.current.get("/api/x")).rejects.toThrow(
      "A board must keep at least one owner"
    );
  });

  it("falls back to statusText when the body cannot be parsed", async () => {
    vi.mocked(fetch).mockResolvedValue(response(false, "Internal Server Error"));
    const { result } = renderHook(() => useApi());

    await expect(result.current.get("/api/x")).rejects.toThrow("Internal Server Error");
  });
});
