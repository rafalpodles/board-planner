import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const getAuthUser = vi.fn();
const getOrganisation = vi.fn();
const aggregate = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class RateLimitError extends Error {} }));
vi.mock("@/lib/organisation", async (original) => ({ ...(await original<typeof import("@/lib/organisation")>()), getOrganisation }));

const { GET } = await import("./route");

const ADMIN = { _id: "admin-1", username: "root", role: "admin", viaMachineCredential: false };
const MEMBER = { _id: "member-1", username: "pat", role: "member", viaMachineCredential: false };
const MB = 1024 * 1024;

const HOST = "app.board-planner.com";
const read = () =>
  GET(new Request(`https://${HOST}/api/organisation/storage`, { headers: { host: HOST } }), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ORGANISATION_DOMAIN;
  delete process.env.ORGANISATION_STORAGE_MB;
  process.env.ORGANISATION_DEFAULT_HOST = HOST;
  process.env.ORGANISATION_REQUESTS_PER_MINUTE = "0";
  getAuthUser.mockResolvedValue(ADMIN);
  getOrganisation.mockResolvedValue({ entitlements: { plan: "free", features: [] } });
  aggregate.mockReturnValue({ toArray: async () => [{ bytes: 300 * MB }] });
  vi.spyOn(mongoose, "connection", "get").mockReturnValue({
    db: { collection: () => ({ aggregate }) },
  } as unknown as mongoose.Connection);
});

describe("GET /api/organisation/storage (BP-967)", () => {
  it("gives an administrator what the organisation holds against its plan's ceiling, and says Pro lifts a Free one", async () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.com";

    const response = await read();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ storedBytes: 300 * MB, limitBytes: 1024 * MB, upgradeLifts: true });
  });

  it("gives a Pro organisation 20 GB and nothing to upgrade to", async () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.com";
    getOrganisation.mockResolvedValue({ entitlements: { plan: "pro", features: [] } });

    expect(await (await read()).json()).toEqual({ storedBytes: 300 * MB, limitBytes: 20480 * MB, upgradeLifts: false });
  });

  it("has no ceiling on a self-hosted instance", async () => {
    expect(await (await read()).json()).toEqual({ storedBytes: 300 * MB, limitBytes: null, upgradeLifts: false });
  });

  it("is for administrators: a member is refused", async () => {
    getAuthUser.mockResolvedValue(MEMBER);

    expect((await read()).status).toBe(403);
    expect(aggregate).not.toHaveBeenCalled();
  });
});
