import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { signLicence } from "@/lib/licence";

const { getAuthUser } = vi.hoisted(() => ({ getAuthUser: vi.fn() }));

vi.mock("@/lib/auth", () => ({ getAuthUser }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));

const { GET } = await import("./route");

const ORIGINAL = { ...process.env };
const DAY = 24 * 60 * 60 * 1000;
const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
const signing = { keyId: "e2e", d: jwk.d!, x: jwk.x! };

function get() {
  return GET(new Request("http://localhost/api/admin/licence"), { params: Promise.resolve({}) });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", username: "admin", role: "admin" });
  process.env.E2E = "1";
  process.env.E2E_LICENCE_PUBLIC_KEY = signing.x;
  delete process.env.LICENCE_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("GET /api/admin/licence", () => {
  it("is refused to a member", async () => {
    getAuthUser.mockResolvedValue({ _id: "u2", username: "member", role: "member" });

    expect((await get()).status).toBe(403);
  });

  it("says no key is configured when LICENCE_KEY is unset", async () => {
    expect(await (await get()).json()).toEqual({ configured: false });
  });

  it("names the verdict and nothing from the payload for a key that does not verify", async () => {
    process.env.LICENCE_KEY = "garbage";

    expect(await (await get()).json()).toEqual({ configured: true, verdict: "malformed" });
  });

  it("describes a valid key with days left counted to its expiry and its grace", async () => {
    const expiresAt = new Date(Date.now() + 10 * DAY - 60_000);
    process.env.LICENCE_KEY = signLicence(
      {
        customer: "Acme Ltd",
        plan: "pro",
        features: [],
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: expiresAt.toISOString(),
      },
      signing
    );

    expect(await (await get()).json()).toEqual({
      configured: true,
      verdict: "valid",
      customer: "Acme Ltd",
      plan: "pro",
      features: [],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: expiresAt.toISOString(),
      graceEndsAt: new Date(expiresAt.getTime() + 14 * DAY).toISOString(),
      daysLeft: 10,
      graceDaysLeft: 24,
      keyId: "e2e",
    });
  });

  // Rounded up, never to the nearest: 30¼ days left is 31, so the 30-day warning has not started
  it("counts a part day as a whole one", async () => {
    const expiresAt = new Date(Date.now() + 30 * DAY + 6 * 60 * 60 * 1000);
    process.env.LICENCE_KEY = signLicence(
      { customer: "Acme Ltd", plan: "pro", features: [], issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: expiresAt.toISOString() },
      signing
    );

    const body = await (await get()).json();

    expect(body.daysLeft).toBe(31);
    expect(body.graceDaysLeft).toBe(45);
  });
});
