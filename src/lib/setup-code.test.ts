import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});

afterEach(() => {
  delete process.env.BOOTSTRAP_TOKEN;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("board-planner.setup-code")];
  vi.restoreAllMocks();
});

async function load() {
  vi.resetModules();
  return import("./setup-code");
}

describe("setupCode", () => {
  it("uses BOOTSTRAP_TOKEN when the operator set one, and never logs it", async () => {
    process.env.BOOTSTRAP_TOKEN = "  chosen-by-the-operator  ";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { setupCode, setupCodeMatches } = await load();

    expect(setupCode()).toBe("chosen-by-the-operator");
    expect(setupCodeMatches("chosen-by-the-operator")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("generates one, prints it once, and keeps it for the life of the process", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = (await load()).setupCode();
    // A second module instance, the way instrumentation and a route handler are
    const { setupCode, setupCodeMatches } = await load();

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(setupCode()).toBe(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(first);
    expect(setupCodeMatches(first)).toBe(true);
  });

  it("ignores a BOOTSTRAP_TOKEN too short to stand in for the generated code, and says so", async () => {
    process.env.BOOTSTRAP_TOKEN = "admin";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { setupCode, setupCodeMatches } = await load();

    expect(setupCodeMatches("admin")).toBe(false);
    expect(setupCode()).toMatch(/^[0-9a-f]{32}$/);
    expect(warn.mock.calls[0][0]).toContain("shorter than 16");
  });

  it.each([[""], [undefined], [42], ["nearly-but-not"]])("refuses %j", async (candidate) => {
    process.env.BOOTSTRAP_TOKEN = "chosen-by-the-operator";
    const { setupCodeMatches } = await load();

    expect(setupCodeMatches(candidate)).toBe(false);
  });
});

describe("refuseSetupCode (BP-847)", () => {
  const TOKEN = "chosen-by-the-operator";

  it("stops a source with an address after ten wrong codes, the right one included", async () => {
    process.env.BOOTSTRAP_TOKEN = TOKEN;
    const { refuseSetupCode } = await load();
    for (let i = 0; i < 10; i++) expect((await refuseSetupCode("203.0.113.7", `wrong-${i}`))?.status).toBe(403);

    expect((await refuseSetupCode("203.0.113.7", "wrong-again"))?.status).toBe(429);
    expect((await refuseSetupCode("203.0.113.7", TOKEN))?.status).toBe(429);
    expect(await refuseSetupCode("203.0.113.8", TOKEN), "another source is not held up").toBeNull();
  });

  it("with no address, never refuses the right code however many wrong ones were sent", async () => {
    process.env.BOOTSTRAP_TOKEN = TOKEN;
    const { refuseSetupCode } = await load();
    for (let i = 0; i < 300; i++) expect((await refuseSetupCode(null, `wrong-${i}`))?.status).toBe(403);

    expect(await refuseSetupCode(null, TOKEN)).toBeNull();
  });

  it("with no address, a wrong code is the same 403 it always was, not a 429", async () => {
    process.env.BOOTSTRAP_TOKEN = TOKEN;
    const { refuseSetupCode } = await load();

    const refused = await refuseSetupCode(null, "wrong");

    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toEqual({ error: "The setup code is missing or wrong." });
  });

  it("accepts the generated code from a caller with no address", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { refuseSetupCode, setupCode } = await load();

    expect(await refuseSetupCode(null, setupCode())).toBeNull();
  });
});
