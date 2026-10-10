import { describe, it, expect, vi, beforeEach } from "vitest";

const setAiLocked = vi.hoisted(() => vi.fn());
const forgetManagedPlans = vi.hoisted(() => vi.fn());
const logPlatformAudit = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai-gateway/lock", () => ({ setAiLocked }));
vi.mock("@/lib/model-keys", () => ({ forgetManagedPlans }));
// What the platform wrapper checks (host, signature, nonce) is its own tests' business: here the handler is what is under test
vi.mock("@/lib/platform-route", () => ({
  withPlatformRequest: (handler: (request: Request, context: unknown) => Promise<Response>) => (request: Request, context: unknown) => handler(request, context),
  logPlatformAudit,
}));

const { POST } = await import("./route");

const ID = "0123456789abcdef01234567";
const send = (data: unknown, id = ID) => POST(new Request("http://platform/x", { method: "POST" }), { keyId: "k1", body: new TextEncoder().encode(typeof data === "string" ? data : JSON.stringify(data)), params: { organisationId: id } } as never);

beforeEach(() => {
  vi.clearAllMocks();
  setAiLocked.mockResolvedValue("ok");
});

// BP-680
describe("POST /api/platform/organisations/:id/ai", () => {
  it("locks with the reason, tells the screens at once, and audits who did it and why", async () => {
    const res = await send({ locked: true, reason: "abuse report 17" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ locked: true });
    expect(setAiLocked).toHaveBeenCalledWith(ID, true, "abuse report 17");
    expect(forgetManagedPlans).toHaveBeenCalledTimes(1);
    expect(logPlatformAudit).toHaveBeenCalledWith({ action: "organisation_ai_locked", keyId: "k1", subject: ID, detail: "abuse report 17" });
  });

  it("unlocks without a reason, whatever it is sent with, and audits it as an unlock", async () => {
    const res = await send({ locked: false, reason: "sent with an unlock" });

    expect(await res.json()).toEqual({ locked: false });
    expect(setAiLocked).toHaveBeenCalledWith(ID, false, "");
    expect(logPlatformAudit).toHaveBeenCalledWith({ action: "organisation_ai_unlocked", keyId: "k1", subject: ID, detail: "" });
  });

  it.each([
    ["a locked that is not a boolean", { locked: "yes" }],
    ["no locked", {}],
    ["a reason that is not text", { locked: true, reason: 5 }],
    ["a reason of 501 characters", { locked: true, reason: "x".repeat(501) }],
    ["a body that is not JSON", "{not json"],
  ])("answers 400 for %s, and changes and tells nothing", async (_case, data) => {
    expect((await send(data)).status).toBe(400);

    expect(setAiLocked).not.toHaveBeenCalled();
    expect(forgetManagedPlans).not.toHaveBeenCalled();
    expect(logPlatformAudit).not.toHaveBeenCalled();
  });

  it("takes a reason of exactly 500 characters", async () => {
    expect((await send({ locked: true, reason: "x".repeat(500) })).status).toBe(200);
  });

  it("answers 404 for an organisation that is not there and 409 for the default one, without telling the screens or logging", async () => {
    setAiLocked.mockResolvedValueOnce("not_found");
    expect((await send({ locked: true })).status).toBe(404);
    setAiLocked.mockResolvedValueOnce("default_organisation");
    expect(await (await send({ locked: true })).json()).toEqual({ error: "The default organisation cannot be locked" });

    expect(forgetManagedPlans).not.toHaveBeenCalled();
    expect(logPlatformAudit).not.toHaveBeenCalled();
  });
});
