import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const exists = vi.fn();
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/organisation", () => ({ Organisation: { exists } }));
vi.mock("./upload-ownership", () => ({ UPLOAD_BUCKET: "uploads", organisationUploads: () => null }));

await import("@/models/all");
const { organisationExport, ExportCutShortError } = await import("./organisation-life-cycle");

const ORGANISATION = new Types.ObjectId("0000000000000000000000a1");
const PAGE = 500;

// The first model asked is served two pages, one full and one short; every other model has nothing
function database() {
  let pages = 0;
  const served = { rows: 0 };
  const model = {
    find: () => {
      const chain: Record<string, unknown> = {};
      for (const step of ["select", "sort", "limit"]) chain[step] = () => chain;
      chain.lean = async () => {
        pages += 1;
        const size = pages === 1 ? PAGE : pages === 2 ? 1 : 0;
        served.rows += size;
        return Array.from({ length: size }, () => ({ _id: new Types.ObjectId() }));
      };
      return chain;
    },
  };
  const db = new Proxy({ organisation: ORGANISATION }, { get: (target, name) => (name === "organisation" ? target.organisation : model) });
  return { db: db as never, served };
}

async function drain(lines: AsyncGenerator<string>): Promise<string[]> {
  const got: string[] = [];
  for await (const line of lines) got.push(line);
  return got;
}

beforeEach(() => exists.mockReset());

// BP-923. The operator's export checked that the organisation was not being deleted once, before the
// first byte, so a delete begun during a long stream left a partial copy that ended like a whole one
describe("an organisation's export is cut short, with an error, when the organisation is deleted underneath it", () => {
  it("runs to its end while the organisation stays — the control", async () => {
    exists.mockResolvedValue({ _id: ORGANISATION });
    const { db, served } = database();

    const lines = await drain(organisationExport(db));

    expect(served.rows).toBe(PAGE + 1);
    expect(lines).toHaveLength(1 + PAGE + 1);
    expect(exists).toHaveBeenCalledWith({ _id: ORGANISATION, deletedAt: null, deletingAt: null });
  });

  it("stops with an error once a delete has begun, after what it had sent", async () => {
    exists.mockResolvedValueOnce({ _id: ORGANISATION }).mockResolvedValue(null);
    const { db, served } = database();
    const got: string[] = [];

    await expect(
      (async () => {
        for await (const line of organisationExport(db)) got.push(line);
      })()
    ).rejects.toBeInstanceOf(ExportCutShortError);

    expect(served.rows, "the second page was not read once the organisation was gone").toBe(PAGE);
    expect(got).toHaveLength(1 + PAGE);
  });

  it("stops before any row when the delete had begun already", async () => {
    exists.mockResolvedValue(null);
    const { db, served } = database();

    await expect(drain(organisationExport(db))).rejects.toThrow(/incomplete/);

    expect(served.rows).toBe(0);
  });
});
