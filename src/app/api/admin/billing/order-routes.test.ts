import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";

const m = vi.hoisted(() => ({ askBilling: vi.fn(), caller: {} as Record<string, unknown> }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/middleware", async () => {
  const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
  return {
    withAdmin:
      (handler: (r: Request, c: unknown) => unknown) =>
      (request: Request) =>
        handler(request, { params: Promise.resolve({}), user: m.caller, db: scopedToDefaultOrganisation() }),
  };
});
vi.mock("@/lib/billing-client", () => ({ askBilling: m.askBilling }));
vi.mock("@/lib/member-limit", () => ({ memberCounts: async () => ({ active: 13, pending: 0 }) }));
vi.mock("@/lib/organisation-host", () => ({ organisationDomain: () => "board-planner.test", organisationOrigin: async () => "https://acme.board-planner.test" }));

const checkout = await import("./checkout/route");

type Route = { POST: (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response> };
const post = (body: unknown) =>
  (checkout as Route).POST(new Request("https://acme.board-planner.test/api/admin/billing/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({}) });

beforeEach(() => {
  m.caller = { email: "boss@acme.test", viaMachineCredential: false };
  m.askBilling.mockReset().mockResolvedValue({ status: "ok", body: { url: "https://checkout.stripe.test/c/1" } });
  vi.stubEnv("LEGAL_TERMS_VERSION", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/billing/checkout", () => {
  it.each([
    ["no consent", { interval: "month" }],
    ["a consent that is not a yes", { interval: "month", immediateStart: "true" }],
    ["a declined consent", { interval: "month", immediateStart: false }],
  ])("refuses %s with 400, and the licence service is never asked", async (_why, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(m.askBilling).not.toHaveBeenCalled();
  });

  it("passes the consent, when it was given, and the Terms in force", async () => {
    vi.stubEnv("LEGAL_TERMS_VERSION", "2026-10");
    const before = Date.now();

    const response = await post({ interval: "year", immediateStart: true });

    expect(response.status).toBe(200);
    const [action, payload] = m.askBilling.mock.calls[0];
    expect(action).toBe("checkout");
    expect(payload).toMatchObject({ organisation: DEFAULT_ORGANISATION_ID.toHexString(), interval: "year", members: 13, immediateStart: true, termsVersion: "2026-10" });
    expect(Date.parse(payload.orderedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(payload.orderedAt)).toBeLessThanOrEqual(Date.now());
  });

  it("passes no Terms while none is in force", async () => {
    await post({ interval: "month", immediateStart: true });

    expect(m.askBilling.mock.calls[0][1]).not.toHaveProperty("termsVersion");
  });

  it("is refused to a machine credential, and the service is never asked", async () => {
    m.caller = { email: "boss@acme.test", viaMachineCredential: true };

    expect((await post({ interval: "month", immediateStart: true })).status).toBe(403);
    expect(m.askBilling).not.toHaveBeenCalled();
  });
});
