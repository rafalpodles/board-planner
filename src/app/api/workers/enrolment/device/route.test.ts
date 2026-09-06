import { describe, it, expect, vi, beforeEach } from "vitest";

const startDeviceEnrolment = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getClientIp: () => "203.0.113.9" }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/device-enrolment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/device-enrolment")>()),
  startDeviceEnrolment,
}));

const { POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");
const { PROTOCOL_VERSION } = await import("@/lib/worker-service");

const SPEAKS = { "content-type": "application/json", "x-cp-protocol": String(PROTOCOL_VERSION) };

function post(body: unknown, headers: Record<string, string> = SPEAKS) {
  return new Request("http://x/api/workers/enrolment/device", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const oversized = (headers?: Record<string, string>) =>
  post({ name: "x".repeat(70 * 1024) }, headers);

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  startDeviceEnrolment.mockResolvedValue({
    deviceCode: "cpd_abc",
    userCode: "ABCD1234",
    expiresAt: new Date("2026-01-01T00:00:00Z"),
    intervalMs: 2000,
  });
});

describe("POST /api/workers/enrolment/device", () => {
  it("enrols a machine — the control", async () => {
    const response = await POST(post({ name: "MacBook", host: "office" }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ deviceCode: "cpd_abc" });
  });

  it("caps the body it will read", async () => {
    const response = await POST(oversized());

    expect(response.status).toBe(413);
    expect(startDeviceEnrolment).not.toHaveBeenCalled();
  });

  it("refuses a throttled caller without reading its body", async () => {
    for (let i = 0; i < 11; i++) await POST(post({ name: "MacBook" }));

    expect((await POST(oversized())).status).toBe(429);
  });

  it("refuses a client speaking another protocol without reading its body", async () => {
    const response = await POST(oversized({ "content-type": "application/json" }));

    expect(response.status).toBe(409);
  });

  it("charges the budget for a request it refused, not only for one it understood", async () => {
    for (let i = 0; i < 11; i++) await POST(oversized());

    expect((await POST(post({ name: "MacBook" }))).status).toBe(429);
  });
});
