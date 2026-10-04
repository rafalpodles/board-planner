import { describe, it, expect, vi, beforeEach } from "vitest";

const upsertSingleton = vi.hoisted(() => vi.fn());
vi.mock("@/lib/singleton", () => ({ upsertSingleton }));

const { Settings, getSettings, updateSettings } = await import("./settings");
const { DEFAULT_TENANT_ID } = await import("@/lib/tenant-field");

beforeEach(() => upsertSingleton.mockReset());

describe("the instance's settings row (BP-663)", () => {
  it("is created in the default tenant by a change, and the change itself is kept", async () => {
    await updateSettings({ $set: { aiModel: "m" } });

    expect(upsertSingleton).toHaveBeenCalledWith(Settings, {
      $set: { aiModel: "m" },
      $setOnInsert: { tenant: DEFAULT_TENANT_ID },
    });
  });

  it("is created in the default tenant by a first read too", async () => {
    await getSettings();

    expect(upsertSingleton).toHaveBeenCalledWith(Settings, {
      $setOnInsert: { aiModel: "gpt-4o-mini", tenant: DEFAULT_TENANT_ID },
    });
  });
});
