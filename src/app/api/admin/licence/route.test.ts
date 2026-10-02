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

  describe("with the clock at 2027-10-01 12:00 UTC", () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: Date.parse("2027-10-01T12:00:00.000Z"), toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function keyExpiring(expiresAt: string) {
      return signLicence(
        { customer: "Acme Ltd", plan: "pro", features: [], issuedAt: "2026-01-01T00:00:00.000Z", expiresAt },
        signing
      );
    }

    it("describes a valid key, its grace end and the calendar days to its expiry", async () => {
      process.env.LICENCE_KEY = keyExpiring("2027-10-11T23:59:59.999Z");

      expect(await (await get()).json()).toEqual({
        configured: true,
        verdict: "valid",
        customer: "Acme Ltd",
        plan: "pro",
        features: [],
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-10-11T23:59:59.999Z",
        graceEndsAt: "2027-10-25T23:59:59.999Z",
        daysLeft: 10,
        keyId: "e2e",
      });
    });

    // A key valid through tomorrow has 1 day left, not the 2 a rounded-up 35.99 hours would give
    it.each([
      ["2027-10-01T23:59:59.999Z", 0],
      ["2027-10-02T23:59:59.999Z", 1],
      ["2027-10-31T23:59:59.999Z", 30],
      ["2027-11-01T00:00:00.000Z", 31],
    ])("counts %s as %i days left", async (expiresAt, daysLeft) => {
      process.env.LICENCE_KEY = keyExpiring(expiresAt);

      expect((await (await get()).json()).daysLeft).toBe(daysLeft);
    });
  });
});
