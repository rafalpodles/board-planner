import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BP-443 review. Making `api.github.com` injectable removed the reason this path could skip the
 * guard every other outbound call goes through: the host was a literal. Now an operator with a
 * typo, or a corporate proxy, decides where a project's token is sent — so it goes through
 * `safeFetch`, which re-checks the destination at every redirect hop and refuses a private address,
 * exactly as `gitlab.ts` has always done.
 *
 * Asserted at the seam rather than through the environment. The first version of this set
 * `NODE_ENV` and `GITHUB_API_BASE_URL` with `vi.stubEnv` and watched a real refusal — which passed
 * alone and failed in the full run, because `process.env` is one object shared by every test file
 * in a worker and another file's `unstubAllEnvs` lands mid-await.
 */

// Hoisted, the way every other spec in this repo declares one: `vi.mock` is lifted above the
// module body, so a plain `const` is not initialised when the factory runs — and the factory then
// quietly hands back the real `safeFetch`, which sends a real request to api.github.com.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));

vi.mock("./safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./safe-fetch")>()),
  safeFetch,
}));

// A unit test must not be able to reach the network even if the mock above ever stops applying
vi.stubGlobal("fetch", () => {
  throw new Error("a unit test reached the network");
});

const { fetchPullRequests, fetchChecks } = await import("./github");

beforeEach(() => {
  vi.clearAllMocks();
  // A fresh Response per call: a body is a stream, and one shared object is empty after the first
  // read — which reads as "Unexpected end of JSON input" from the second caller onwards
  safeFetch.mockImplementation(async () => new Response("[]", { status: 200 }));
});

describe("where a project's token may be sent", () => {
  it("lists pull requests through the guarded fetch, not a bare one", async () => {
    await fetchPullRequests("o", "r", "the-token");

    expect(safeFetch).toHaveBeenCalled();
    for (const [url, init, destination] of safeFetch.mock.calls) {
      expect(String(url)).toContain("/repos/o/r/pulls");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer the-token");
      expect(destination).toHaveProperty("allowLoopback");
    }
  });

  it("reads checks through it too", async () => {
    // Per URL: the two endpoints have different shapes, and one answer for both hands the
    // commit-status reducer a body with no `statuses` in it
    safeFetch.mockImplementation(async (url: string) =>
      new Response(
        JSON.stringify(
          String(url).includes("/check-runs")
            ? { total_count: 0, check_runs: [] }
            : { state: "pending", statuses: [] }
        ),
        { status: 200 }
      )
    );

    await fetchChecks("o", "r", "sha1", "the-token");

    expect(safeFetch.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/commits/sha1/check-runs"),
      expect.stringContaining("/commits/sha1/status"),
    ]);
  });

  /**
   * The carve-out `mcp-client.ts` already makes on the same condition, and the reason the suite's
   * own GitHub is reachable at all: a stub on this machine is a private address by definition.
   * Production refuses one.
   */
  it("allows a loopback destination only outside production", async () => {
    await fetchPullRequests("o", "r", "t");

    const [, , destination] = safeFetch.mock.calls[0];
    expect(destination.allowLoopback).toBe(process.env.NODE_ENV !== "production");
  });

  // A body is read bounded, so a host answering an error with a gigabyte cannot exhaust the
  // container while being politely refused (BP-317)
  it("does not swallow an unbounded body on a refusal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const text = vi.fn(async () => "x".repeat(10));
    safeFetch.mockImplementation(async () => ({
      ok: false,
      status: 500,
      url: "http://x/repos/o/r/pulls",
      headers: new Headers(),
      body: null,
      text,
    }) as unknown as Response);

    await expect(fetchPullRequests("o", "r", "t")).rejects.toThrow("GitHub answered 500");
    // readBoundedText reads the stream, never `.text()` on the whole response
    expect(text).not.toHaveBeenCalled();
  });
});
