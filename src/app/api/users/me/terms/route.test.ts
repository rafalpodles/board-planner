import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";

const getAuthUser = vi.fn();
const userUpdateOne = vi.fn();
const logInstanceAudit = vi.fn();
const legalTermsVersion = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, getClientIp: () => "203.0.113.9" }));
vi.mock("@/lib/session", () => ({ ProvenanceError: class ProvenanceError extends Error {} }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/grants", () => ({ check: vi.fn(), accessibleProjectIds: vi.fn() }));
vi.mock("@/models/user", () => ({ User: { updateOne: userUpdateOne } }));
vi.mock("@/lib/legal-terms", () => ({ legalTermsVersion }));

const { POST } = await import("./route");

const PERSON = { _id: "u1", username: "ada", role: "member", kind: "human", sessionId: "s1" };
const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/users/me/terms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(PERSON);
  legalTermsVersion.mockReturnValue("2026-10-15");
  userUpdateOne.mockResolvedValue({});
});

describe("POST /api/users/me/terms (BP-939)", () => {
  it("records that the person saw the change, and when, and never as an acceptance", async () => {
    const res = await post({ version: "2026-10-15" });

    expect(res.status).toBe(200);
    expect(userUpdateOne).toHaveBeenCalledWith(
      { _id: "u1", organisation: DEFAULT_ORGANISATION_ID },
      { $set: { termsNotifiedVersion: "2026-10-15", termsNotifiedAt: expect.any(Date) } }
    );
    expect(JSON.stringify(userUpdateOne.mock.calls)).not.toContain("termsAccepted");
    expect(logInstanceAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "terms_change_seen" }));
  });

  it("names in the audit row the version the person had accepted", async () => {
    getAuthUser.mockResolvedValue({ ...PERSON, termsAcceptedVersion: "2026-01-01" });

    await post({ version: "2026-10-15" });

    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "terms_change_seen", detail: "the terms of 2026-10-15, accepted 2026-01-01" })
    );
  });

  it("refuses a version other than the current one, as a page loaded before a change would send", async () => {
    const res = await post({ version: "2026-01-01" });

    expect(res.status).toBe(409);
    expect(userUpdateOne).not.toHaveBeenCalled();
  });

  it.each([
    ["a machine credential", { ...PERSON, viaMachineCredential: true }],
    ["a machine account", { ...PERSON, kind: "machine" }],
  ])("refuses %s: only a person is told", async (_, user) => {
    getAuthUser.mockResolvedValue(user);

    expect((await post({ version: "2026-10-15" })).status).toBe(403);
    expect(userUpdateOne).not.toHaveBeenCalled();
  });

  it("has nothing to record while no terms are published", async () => {
    legalTermsVersion.mockReturnValue(null);

    expect((await post({ version: "2026-10-15" })).status).toBe(404);
    expect(userUpdateOne).not.toHaveBeenCalled();
  });
});
