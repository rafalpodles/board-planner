import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScopedDb } from "@/lib/db-scope";

const getSettings = vi.hoisted(() => vi.fn());
vi.mock("@/models/settings", () => ({ getSettings }));

const { resolvePmModel } = await import("./availability");

const db = {} as ScopedDb;

beforeEach(() => getSettings.mockReset().mockResolvedValue({ aiModel: "openai/the-one-model" }));

// BP-1006: AI Assist and the PM agent run on one model
describe("the model a PM turn runs on", () => {
  it("is the project's own when it names one, and the instance is not read", async () => {
    expect(await resolvePmModel(db, "x/own")).toBe("x/own");
    expect(getSettings).not.toHaveBeenCalled();
  });

  it("is the instance's one model when the project names none", async () => {
    expect(await resolvePmModel(db)).toBe("openai/the-one-model");
    expect(await resolvePmModel(db, "")).toBe("openai/the-one-model");
  });

  it("qualifies a bare name the way AI Assist does, so the same setting means the same model to both", async () => {
    getSettings.mockResolvedValue({ aiModel: "gpt-4o-mini" });

    expect(await resolvePmModel(db)).toBe("openai/gpt-4o-mini");
  });

  it("ignores a PM_MODEL left in the environment", async () => {
    vi.stubEnv("PM_MODEL", "env/leftover");
    try {
      expect(await resolvePmModel(db)).toBe("openai/the-one-model");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
