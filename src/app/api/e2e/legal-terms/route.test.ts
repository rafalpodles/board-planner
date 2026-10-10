import { describe, it, expect, vi, beforeEach } from "vitest";

const setVersion = vi.fn();
vi.mock("@/lib/legal-terms", () => ({ setE2eLegalTermsVersion: (...args: unknown[]) => setVersion(...args) }));

const mounted = vi.fn();
vi.mock("@/lib/e2e-only", () => ({ e2eOnlyMounted: (...args: unknown[]) => mounted(...args) }));

const { POST } = await import("./route");

const post = (body: unknown) => POST(new Request("http://x/api/e2e/legal-terms", { method: "POST", body: JSON.stringify(body) }));

// BP-939: the version decides whom every sign-up refuses, and nothing authenticates this route
describe("POST /api/e2e/legal-terms", () => {
  beforeEach(() => {
    setVersion.mockClear();
    mounted.mockReset();
  });

  it("is not there when the gate is shut, and changes nothing", async () => {
    mounted.mockReturnValue(false);

    expect((await post({ version: "2026-10-15" })).status).toBe(404);
    expect(setVersion).not.toHaveBeenCalled();
  });

  it("sets the version, or restores the variable when none is given", async () => {
    mounted.mockReturnValue(true);

    expect((await post({ version: "2026-10-15" })).status).toBe(204);
    expect((await post({})).status).toBe(204);
    expect(setVersion.mock.calls).toEqual([["2026-10-15"], [undefined]]);
  });

  it("refuses a version that is not a string", async () => {
    mounted.mockReturnValue(true);

    expect((await post({ version: 7 })).status).toBe(400);
    expect(setVersion).not.toHaveBeenCalled();
  });
});
