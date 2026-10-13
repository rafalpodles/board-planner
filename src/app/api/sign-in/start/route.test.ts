import { describe, it, expect, vi, beforeEach } from "vitest";

const startSignIn = vi.fn();
const sendEmail = vi.fn();
let clientIp: string | null = "203.0.113.9";

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/client-ip", () => ({ getClientIp: () => clientIp }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/platform-sign-in", () => ({ CODE_TTL_MS: 600_000, startSignIn }));
vi.mock("@/lib/platform-sign-in-route", () => ({
  signInRoute: (handler: unknown) => handler,
  signInCookie: (binder: string) => `bp_platform_signin=${binder}`,
}));
vi.mock("@/lib/session", () => ({ provenanceRefusal: () => null }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  isEmailConfigured: () => true,
  sendEmail,
}));

const { POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

function post(email: string) {
  return new Request("https://login.example.com/api/sign-in/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  clientIp = "203.0.113.9";
  await resetRateLimits();
  startSignIn.mockResolvedValue({ binder: "bps_x", code: "123456" });
  sendEmail.mockResolvedValue(true);
});

describe("POST /api/sign-in/start", () => {
  it("sends a code — the control", async () => {
    const response = await POST(post("person@example.com"));

    expect(response.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "person@example.com" }));
  });

  it("throttles one address asking for codes for different people", async () => {
    for (let i = 0; i < 20; i++) expect((await POST(post(`p${i}@example.com`))).status).toBe(200);

    expect((await POST(post("another@example.com"))).status).toBe(429);
  });

  // BP-1030. Mail goes to whoever is typed, so without an address callers keep sharing one bucket
  // rather than being uncounted: 20 times the per-address figure, which is 400. Spraying addresses
  // past it is refused, and nothing is sent for the refused ones.
  it("keeps a shared bucket for callers with no address, because it sends mail to anybody", async () => {
    clientIp = null;
    for (let i = 0; i < 400; i++) expect((await POST(post(`p${i}@example.com`))).status).toBe(200);

    expect((await POST(post("another@example.com"))).status).toBe(429);
    expect(sendEmail).toHaveBeenCalledTimes(400);
  });

  it("still holds one e-mail address to a few codes when there is no client address", async () => {
    clientIp = null;
    for (let i = 0; i < 5; i++) expect((await POST(post("person@example.com"))).status).toBe(200);

    expect((await POST(post("person@example.com"))).status).toBe(429);
  });
});
