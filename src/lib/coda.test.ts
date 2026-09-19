import { describe, it, expect, vi } from "vitest";

/**
 * BP-472. `codaFetch` used to call `safeFetch` with no `DestinationOptions` at all, which is a
 * silent refusal of `127.0.0.1` in every environment — not just production — because
 * `allowLoopback` defaults to false. Mirroring `GITHUB_DESTINATION` (`github.ts`) is what lets
 * `e2e/coda-stub.mjs` be reachable; this pins the wiring rather than `allowLoopbackIn`'s own
 * NODE_ENV logic, which `github.ts` already owns.
 */

const safeFetch = vi.fn(
  (_url: string, _init?: RequestInit, _options?: { allowLoopback?: boolean }) =>
    Promise.resolve(new Response(JSON.stringify({ items: [] })))
);
vi.mock("./safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./safe-fetch")>()),
  safeFetch,
}));

const { fetchTableColumns } = await import("./coda");

describe("fetchTableColumns", () => {
  it("passes a DestinationOptions that allows loopback outside production", async () => {
    await fetchTableColumns("http://127.0.0.1:9999", "doc1", "table1", "tok");

    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [, , destination] = safeFetch.mock.calls[0];
    // vitest itself runs with NODE_ENV=test, so this is the same "not production" case the e2e
    // stub relies on — asserting the concrete value, not just that some object was passed
    expect(destination).toEqual({ allowLoopback: true });
  });
});
