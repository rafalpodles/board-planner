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
const withdraw = await import("./withdraw/route");

type Route = { POST: (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response> };
const post = (route: Route, body: unknown) =>
  route.POST(new Request("https://acme.board-planner.test/api/admin/billing/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({}) });

beforeEach(() => {
  m.caller = { email: "boss@acme.test", viaMachineCredential: false };
  m.askBilling.mockReset().mockResolvedValue({ status: "ok", body: { url: "https://checkout.stripe.test/c/1" } });
  vi.stubEnv("LEGAL_TERMS_VERSION", "");
});
afterEach(() => vi.unstubAllEnvs());

// BP-941
describe("POST /api/admin/billing/checkout", () => {
  it.each([
    ["no buyer type", { interval: "month" }],
    ["a buyer type that is neither", { interval: "month", buyer: "company" }],
    ["a consumer who did not ask for Pro to start at once", { interval: "month", buyer: "consumer" }],
    ["a consumer whose request is not a yes", { interval: "month", buyer: "consumer", immediateStart: "true" }],
  ])("refuses %s with 400, and the licence service is never asked", async (_why, body) => {
    const response = await post(checkout, body);

    expect(response.status).toBe(400);
    expect(m.askBilling).not.toHaveBeenCalled();
  });

  it("passes a consumer's request to start at once, with when it was made, and the Terms in force", async () => {
    vi.stubEnv("LEGAL_TERMS_VERSION", "2026-10");
    const before = Date.now();

    const response = await post(checkout, { interval: "year", buyer: "consumer", immediateStart: true });

    expect(response.status).toBe(200);
    const [action, payload] = m.askBilling.mock.calls[0];
    expect(action).toBe("checkout");
    expect(payload).toMatchObject({ organisation: DEFAULT_ORGANISATION_ID.toHexString(), interval: "year", members: 13, buyer: "consumer", immediateStart: true, termsVersion: "2026-10" });
    expect(Date.parse(payload.orderedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(payload.orderedAt)).toBeLessThanOrEqual(Date.now());
  });

  it("passes a business with no request, whatever the browser sent, and no Terms while none is in force", async () => {
    await post(checkout, { interval: "month", buyer: "business", immediateStart: true });

    const [, payload] = m.askBilling.mock.calls[0];
    expect(payload).toMatchObject({ buyer: "business", immediateStart: false });
    expect(payload).not.toHaveProperty("termsVersion");
  });
});

describe("POST /api/admin/billing/withdraw", () => {
  it("asks the licence service to withdraw this organisation, and says what was refunded", async () => {
    m.askBilling.mockResolvedValue({ status: "ok", body: { status: "withdrawn", at: "2026-10-08T10:00:00.000Z", refunded: { amount: 3812, currency: "eur" } } });

    const response = await post(withdraw, {});

    expect([response.status, await response.json()]).toEqual([200, { withdrawn: true, at: "2026-10-08T10:00:00.000Z", refunded: { amount: 3812, currency: "eur" } }]);
    expect(m.askBilling).toHaveBeenCalledWith("withdraw", { organisation: DEFAULT_ORGANISATION_ID.toHexString() });
  });

  it("says a subscription that can no longer be withdrawn from is out of date on the page, and a failure is the payment service's", async () => {
    m.askBilling.mockResolvedValueOnce({ status: "refused", httpStatus: 409, body: { reason: "period_over" } });
    const refused = await post(withdraw, {});
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/can no longer be withdrawn from/);

    m.askBilling.mockResolvedValueOnce({ status: "unreachable" });
    expect((await post(withdraw, {})).status).toBe(502);
  });

  it("is refused to a machine credential, and the service is never asked", async () => {
    m.caller = { email: "boss@acme.test", viaMachineCredential: true };

    expect((await post(withdraw, {})).status).toBe(403);
    expect((await post(checkout, { interval: "month", buyer: "business" })).status).toBe(403);
    expect(m.askBilling).not.toHaveBeenCalled();
  });
});
