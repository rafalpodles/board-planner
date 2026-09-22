import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * BP-322. This route had no test at any level, and the ticket's own claim — that the throttle runs
 * before the body — was untestable without one. An oversized body is what tells the orders apart:
 * 429 means the caller was refused before the server read it, 413 means it read 70 KB from a caller
 * it had already decided to turn away.
 */

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
  process.env.PUBLIC_ORIGIN = "https://board.example.org";
  await resetRateLimits();
  startDeviceEnrolment.mockResolvedValue({
    deviceCode: "cpd_abc",
    userCode: "ABCD1234",
    expiresAt: new Date("2026-01-01T00:00:00Z"),
    intervalMs: 2000,
  });
});

afterEach(() => {
  delete process.env.PUBLIC_ORIGIN;
  delete process.env.APP_ORIGIN;
  delete process.env.NEXT_PUBLIC_APP_URL;
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
    // Ten oversized requests are ten requests. Counting only the ones that parse would leave the
    // cheapest way to spend the server's time as the one way that costs the caller nothing.
    for (let i = 0; i < 11; i++) await POST(oversized());

    expect((await POST(post({ name: "MacBook" }))).status).toBe(429);
  });
});

// BP-766. The app opens this address on the operator's Mac, and a published image is built once
// for every self-hoster: a build-time NEXT_PUBLIC_APP_URL would send them all to localhost:3000
describe("POST /api/workers/enrolment/device — where the operator is sent", () => {
  it("sends the operator to PUBLIC_ORIGIN, read at runtime", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    const response = await POST(post({ name: "MacBook" }));

    expect(response.status).toBe(201);
    expect((await response.json()).verificationUrl).toBe("https://board.example.org/enrol/ABCD1234");
  });

  it("takes APP_ORIGIN when it names exactly one origin", async () => {
    delete process.env.PUBLIC_ORIGIN;
    process.env.APP_ORIGIN = "https://lan.example.org";

    const response = await POST(post({ name: "MacBook" }));

    expect((await response.json()).verificationUrl).toBe("https://lan.example.org/enrol/ABCD1234");
  });

  it("refuses to start an enrolment it could not send anyone to approve", async () => {
    delete process.env.PUBLIC_ORIGIN;
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    const response = await POST(post({ name: "MacBook" }));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/PUBLIC_ORIGIN/);
    expect(startDeviceEnrolment).not.toHaveBeenCalled();
  });
});
