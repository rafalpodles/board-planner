import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const find = vi.hoisted(() => vi.fn());
vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/organisation", () => ({ Organisation: { find } }));

const { servedOrganisations, forEachServedOrganisation } = await import("./organisation-jobs");
const { DEFAULT_ORGANISATION_ID } = await import("./organisation-field");

const A = new Types.ObjectId("0000000000000000000000a1");
const B = new Types.ObjectId("0000000000000000000000b2");
const rows = (list: unknown[]) => ({ select: () => ({ lean: async () => list }) });

beforeEach(() => find.mockReset());
afterEach(() => {
  delete process.env.ORGANISATION_DOMAIN;
});

describe("the organisations background work serves (BP-667)", () => {
  it("is the default organisation alone on a single-organisation instance, even before its row exists", async () => {
    find.mockReturnValue(rows([]));
    expect(await servedOrganisations()).toEqual([{ _id: DEFAULT_ORGANISATION_ID }]);
    expect(find).toHaveBeenCalledWith({ _id: DEFAULT_ORGANISATION_ID });
  });

  it("is every organisation, with its own clock, when organisations live on subdomains", async () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.com";
    find.mockReturnValue(rows([{ _id: A, timezone: "Asia/Tokyo" }, { _id: B }]));

    expect(await servedOrganisations()).toEqual([{ _id: A, timezone: "Asia/Tokyo" }, { _id: B }]);
    expect(find).toHaveBeenCalledWith({});
  });

  it("hands each organisation its own db, and one organisation's failure does not stop the next", async () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.com";
    find.mockReturnValue(rows([{ _id: A }, { _id: B }]));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];

    await forEachServedOrganisation("test job", async (db) => {
      seen.push(db.organisation.toHexString());
      if (db.organisation.equals(A)) throw new Error("A broke");
    });

    expect(seen).toEqual([A.toHexString(), B.toHexString()]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`test job failed for organisation ${A.toHexString()}`), expect.any(Error));
  });
});
