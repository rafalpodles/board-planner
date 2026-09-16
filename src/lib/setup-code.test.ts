import { describe, it, expect, vi, afterEach } from "vitest";

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
