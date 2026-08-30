import { describe, it, expect, vi, beforeEach } from "vitest";

const countDocuments = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/user", () => ({ User: { countDocuments } }));

const { GET } = await import("./route");

beforeEach(() => vi.clearAllMocks());

/**
 * BP-268. The page used to offer account creation unconditionally; this is the fact it was
 * missing. It decides what is offered, never what is allowed — POST /api/users counts the users
 * itself and refuses a second bootstrap whatever any client believes.
 */
describe("GET /api/auth/instance", () => {
  it("says an empty instance is unclaimed", async () => {
    countDocuments.mockResolvedValue(0);

    expect(await (await GET()).json()).toEqual({ unclaimed: true });
  });

  // The control, and the half the bug was on: without it "answers unclaimed" and "answers the
  // same thing whatever the database holds" are indistinguishable
  it("says an instance with one user is not", async () => {
    countDocuments.mockResolvedValue(1);

    expect(await (await GET()).json()).toEqual({ unclaimed: false });
  });

  // Unreachable is not unclaimed: the page would offer to create an administrator on an instance
  // that may already have one
  it("refuses to answer at all when the database cannot be read", async () => {
    countDocuments.mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED"), { name: "MongooseServerSelectionError" })
    );

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.json()).not.toMatchObject({ unclaimed: true });
  });
});
