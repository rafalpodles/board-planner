import { describe, it, expect, vi, beforeEach } from "vitest";
import sift from "sift";
import { DEFAULT_TENANT_ID } from "@/lib/tenant-field";

const getAuthUser = vi.fn();
const workerRows: Record<string, unknown>[] = [];
const workerQueries: { filter: Record<string, unknown>; projection: string }[] = [];

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
// Honours the filter and the projection it is given, so a field the route forgets to select, or an
// owner it forgets to filter on, is visible here too
vi.mock("@/models/worker", () => ({
  Worker: {
    find: (filter: Record<string, unknown>, projection: string) => {
      workerQueries.push({ filter, projection });
      const keep = new Set(["_id", ...projection.split(/\s+/).filter(Boolean)]);
      const rows = workerRows
        .filter(sift(filter))
        .map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k))));
      return { sort: () => ({ lean: async () => rows }) };
    },
  },
}));

const { GET } = await import("./route");

const READER = "507f1f77bcf86cd799439011";
const COLLEAGUE = "507f1f77bcf86cd799439012";
const recently = () => new Date(Date.now() - 1_000);
const longAgo = () => new Date(Date.now() - 60 * 60 * 1000);

function machine(over: Record<string, unknown> = {}) {
  return {
    _id: "6a7309535eb49af333b85a04",
    name: "MacBook",
    host: "ada.local",
    version: "1.1.3",
    owner: READER,
    tenant: DEFAULT_TENANT_ID,
    enabled: true,
    lastSeenAt: recently(),
    repos: [{ remote: "git@github.com:acme/orbit.git", path: "/Users/ada/orbit" }],
    credentialHash: "$2b$10$secret",
    command: "",
    ...over,
  };
}

async function read() {
  const res = await GET(new Request("http://localhost/api/users/me/machines") as never, {
    params: Promise.resolve({}),
  } as never);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  workerRows.length = 0;
  workerQueries.length = 0;
  getAuthUser.mockResolvedValue({ _id: READER, role: "member" });
});

describe("GET /api/users/me/machines", () => {
  it("lists the reader's own machines and nobody else's", async () => {
    workerRows.push(machine(), machine({ _id: "6a7309535eb49af333b85a05", name: "Theirs", owner: COLLEAGUE }));

    const { status, body } = await read();

    expect(status).toBe(200);
    expect(body.map((m: { name: string }) => m.name)).toEqual(["MacBook"]);
  });

  it("says what each machine is doing, in the words the task uses", async () => {
    workerRows.push(
      machine({ _id: "6a7309535eb49af333b85a01", name: "live" }),
      machine({ _id: "6a7309535eb49af333b85a02", name: "quiet", lastSeenAt: longAgo() }),
      machine({ _id: "6a7309535eb49af333b85a03", name: "off", enabled: false, lastSeenAt: longAgo() }),
      machine({
        _id: "6a7309535eb49af333b85a06",
        name: "paused here",
        halt: { paused: true, by: "machine", command: "pause", reportedAt: new Date() },
      }),
      machine({
        _id: "6a7309535eb49af333b85a07",
        name: "no sandbox",
        preflight: { ok: false, account: "", checks: [{ name: "sandbox", ok: false, detail: "seatbelt is macOS only" }], reportedAt: new Date() },
      })
    );

    const { body } = await read();

    expect(body.map((m: { name: string; state: string; haltedBy: string | null }) => [m.name, m.state, m.haltedBy])).toEqual([
      ["live", "live", null],
      ["quiet", "stale", null],
      ["off", "disabled", null],
      ["paused here", "paused", "machine"],
      ["no sandbox", "failing", null],
    ]);
  });

  it("answers the count of checkouts, never their paths, and never the credential", async () => {
    workerRows.push(machine());

    const { body } = await read();

    expect(body[0]).toEqual({
      _id: "6a7309535eb49af333b85a04",
      name: "MacBook",
      host: "ada.local",
      version: "1.1.3",
      lastSeenAt: expect.any(String),
      state: "live",
      haltedBy: null,
      checkouts: 1,
    });
    expect(JSON.stringify(body)).not.toContain("/Users/ada");
    expect(workerQueries[0].projection).not.toContain("credentialHash");
  });

  it("answers an empty list to somebody with no machine", async () => {
    expect((await read()).body).toEqual([]);
  });

  it("refuses a machine credential, and reads nothing", async () => {
    getAuthUser.mockResolvedValue({ _id: READER, role: "member", viaMachineCredential: true });

    const { status, body } = await read();

    expect(status).toBe(403);
    expect(body.error).toBe("Interactive session required");
    expect(workerQueries).toEqual([]);
  });

  it("refuses somebody signed out", async () => {
    getAuthUser.mockResolvedValue(null);

    expect((await read()).status).toBe(401);
  });
});
