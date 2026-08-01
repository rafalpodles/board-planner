import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const workerFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/models/worker", () => ({ Worker: { find: workerFind } }));

const { GET } = await import("./route");

const ADMIN = { _id: "admin-1", role: "admin", tokenScoped: false, allowedProjects: [] };
const MEMBER = { _id: "member-1", role: "member", tokenScoped: false, allowedProjects: [] };

function workerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: "69a52e3b399b27d3cbb2c5a5",
    name: "laptop-1",
    host: "mac.local",
    platform: "darwin",
    version: "1.0.0",
    protocolVersion: 1,
    assignments: [],
    policy: {
      baseBranch: "main",
      pollIntervalMs: 30_000,
      taskTimeoutMs: 1_800_000,
      maxDiffLines: 400,
      maxDiffFiles: 10,
      model: "opus",
    },
    enabled: true,
    lockedByInstance: false,
    lastSeenAt: new Date(),
    bindingError: "",
    command: "",
    commandIssuedAt: null,
    commandAckedAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date(),
    credentialHash: "should-never-reach-the-client",
    ...overrides,
  };
}

function request() {
  return new Request("http://localhost/api/admin/workers");
}

function mockFleet(list: unknown[]) {
  workerFind.mockReturnValue({ sort: () => Promise.resolve(list) });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(ADMIN);
  mockFleet([]);
});

describe("GET /api/admin/workers", () => {
  it("refuses a non-admin", async () => {
    getAuthUser.mockResolvedValue(MEMBER);

    const response = await GET(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(403);
    expect(workerFind).not.toHaveBeenCalled();
  });

  it("lists the fleet with credentialHash stripped and staleness derived", async () => {
    const fresh = workerDoc({ _id: "a1", name: "fresh-worker", lastSeenAt: new Date() });
    const stale = workerDoc({
      _id: "a2",
      name: "stale-worker",
      lastSeenAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    mockFleet([fresh, stale]);

    const response = await GET(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toHaveLength(2);
    expect(json.every((w: Record<string, unknown>) => !("credentialHash" in w))).toBe(true);
    expect(json.find((w: { name: string }) => w.name === "fresh-worker").stale).toBe(false);
    expect(json.find((w: { name: string }) => w.name === "stale-worker").stale).toBe(true);
  });
});
