import { describe, it, expect, vi, beforeEach } from "vitest";

const countDocuments = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/user", () => ({ User: { countDocuments } }));

const { GET } = await import("./route");

beforeEach(() => vi.clearAllMocks());

describe("GET /api/auth/instance", () => {
  it("says an empty instance is unclaimed", async () => {
    countDocuments.mockResolvedValue(0);

    expect(await (await GET()).json()).toEqual({ unclaimed: true });
  });

  it("says an instance with one user is not", async () => {
    countDocuments.mockResolvedValue(1);

    expect(await (await GET()).json()).toEqual({ unclaimed: false });
  });

  it("refuses to answer at all when the database cannot be read", async () => {
    countDocuments.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED"), { name: "MongooseServerSelectionError" })
    );

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.json()).not.toMatchObject({ unclaimed: true });
  });
});
