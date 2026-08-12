import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlannerClient } from "./planner-client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function requestedUrl(): string {
  return fetchMock.mock.calls.at(-1)![0] as string;
}

// BP-316: tool arguments become path segments, and the WHATWG parser normalises `..` away — so a
// tool argument chose the path the server fetched rather than the resource it named.
describe("PlannerClient path building", () => {
  const client = new PlannerClient("https://board.example.com", "cp_token");

  it("encodes a traversal attempt instead of letting it climb", async () => {
    await client.getProject("../../latest/meta-data").catch(() => {});

    expect(requestedUrl()).toBe(
      "https://board.example.com/api/projects/..%2F..%2Flatest%2Fmeta-data"
    );
    expect(new URL(requestedUrl()).pathname).toBe("/api/projects/..%2F..%2Flatest%2Fmeta-data");
  });

  it("encodes every segment of a nested path", async () => {
    await client.getTask("p/1", "t?2").catch(() => {});

    expect(requestedUrl()).toBe("https://board.example.com/api/projects/p%2F1/tasks/t%3F2");
  });

  it("does not let a segment introduce a query string", async () => {
    await client.listTasks("p1?admin=1").catch(() => {});

    expect(new URL(requestedUrl()).searchParams.has("admin")).toBe(false);
  });

  it("still builds an ordinary path unchanged", async () => {
    await client.getTask("507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012").catch(() => {});

    expect(requestedUrl()).toBe(
      "https://board.example.com/api/projects/507f1f77bcf86cd799439011/tasks/507f1f77bcf86cd799439012"
    );
  });

  it("keeps the configured base URL, whatever the argument says", async () => {
    await client.getProject("//attacker.example/x").catch(() => {});

    expect(new URL(requestedUrl()).origin).toBe("https://board.example.com");
  });
});
