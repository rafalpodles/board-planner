import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const rows = vi.hoisted(() => ({ value: [] as Record<string, unknown>[] }));
const lastActiveOf = vi.hoisted(() => vi.fn());

vi.mock("@/models/organisation", () => {
  const chain = { sort: () => chain, limit: () => chain, select: () => chain, lean: async () => rows.value };
  return { Organisation: { find: () => chain } };
});
vi.mock("@/lib/db-scope", () => ({
  scoped: () => ({ User: { countDocuments: async () => 2 }, Project: { countDocuments: async () => 3 } }),
}));
vi.mock("@/lib/organisation", () => ({ licenceOf: () => null }));
vi.mock("@/lib/organisation-limits", () => ({ organisationUsage: async () => null }));
vi.mock("@/lib/ai-gateway/summary", () => ({ aiUsageSummary: async () => null }));
vi.mock("@/lib/dead-organisations", () => ({ lastActiveOf }));
vi.mock("@/lib/platform-route", () => ({
  withPlatformRequest: (handler: (request: Request, context: unknown) => Promise<Response>) => (request: Request, context: unknown) => handler(request, context),
  logPlatformAudit: vi.fn(),
}));

const { GET } = await import("./route");

const list = async () => {
  const res = await GET(new Request("http://platform/api/platform/organisations"), { keyId: "k1" } as never);
  expect(res.status).toBe(200);
  return (await res.json()).organisations as Record<string, unknown>[];
};

beforeEach(() => {
  vi.clearAllMocks();
});

// BP-1115
describe("GET /api/platform/organisations", () => {
  it("names when anybody last used each organisation, as the dead-organisation sweep reads it, and when the sweep warned it", async () => {
    const id = new Types.ObjectId();
    const notice = new Date("2026-09-01T00:00:00Z");
    rows.value = [{ _id: id, name: "Acme", slug: "acme", deadNoticeAt: notice }];
    lastActiveOf.mockResolvedValue(new Date("2026-08-15T10:00:00Z"));

    const [row] = await list();

    expect(row).toMatchObject({ lastActiveAt: "2026-08-15T10:00:00.000Z", deadNoticeAt: notice.toISOString() });
    expect(lastActiveOf).toHaveBeenCalledWith(id, id.getTimestamp());
  });

  it("never dates an organisation after now, from an id minted with a clock running ahead, as the sweep does", async () => {
    const ahead = Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000) + 86_400);
    rows.value = [{ _id: ahead, name: "Ahead", slug: "ahead" }];
    lastActiveOf.mockResolvedValue(new Date());

    await list();

    expect(lastActiveOf.mock.calls[0][1].getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("has neither for a deleted organisation, and reads nothing inside it", async () => {
    rows.value = [{ _id: new Types.ObjectId(), name: "Gone", slug: "gone", deletedAt: new Date() }];

    const [row] = await list();

    expect(row).toMatchObject({ lastActiveAt: null, deadNoticeAt: null });
    expect(lastActiveOf).not.toHaveBeenCalled();
  });
});
