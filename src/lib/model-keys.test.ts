import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type { Plan } from "./entitlements";

const getOrganisation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/organisation", () => ({ getOrganisation }));

const { encryptSecret } = await import("./encryption");
const { describeModelKeyRefusal, resolveModelKey } = await import("./model-keys");

const ORGANISATION = new Types.ObjectId();
const OTHER = new Types.ObjectId();

function dbWith(settings: { openrouterKey?: string; openaiKey?: string } | null) {
  return {
    organisation: ORGANISATION,
    Settings: { findOne: () => ({ lean: async () => settings }) },
  } as never;
}

function organisationOn(plan: Plan) {
  getOrganisation.mockResolvedValue({ entitlements: { plan, features: [], source: "service" } });
}

const ENV = ["ORGANISATION_DOMAIN", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "OPENAPI_KEY", "ENCRYPTION_KEY"] as const;

beforeEach(() => {
  for (const name of ENV) delete process.env[name];
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  getOrganisation.mockReset();
});
afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

describe("a self-hosted instance (no ORGANISATION_DOMAIN)", () => {
  it("uses the instance's key: it is the customer's own", async () => {
    process.env.OPENROUTER_API_KEY = "sk-instance";

    expect(await resolveModelKey(dbWith(null), "openrouter")).toEqual({ ok: true, key: "sk-instance", source: "instance" });
    expect(getOrganisation).not.toHaveBeenCalled();
  });

  it("answers not configured when there is no key anywhere", async () => {
    expect(await resolveModelKey(dbWith(null), "openrouter")).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("reads OpenAI's key from either variable it has always accepted", async () => {
    process.env.OPENAPI_KEY = "sk-old-spelling";

    expect(await resolveModelKey(dbWith(null), "openai")).toMatchObject({ ok: true, key: "sk-old-spelling" });
  });

  it("prefers a key the organisation stored over the environment's", async () => {
    process.env.OPENROUTER_API_KEY = "sk-instance";
    const own = encryptSecret("sk-own", ORGANISATION);

    expect(await resolveModelKey(dbWith({ openrouterKey: own }), "openrouter")).toEqual({
      ok: true,
      key: "sk-own",
      source: "own",
    });
  });
});

describe("a cloud organisation (ORGANISATION_DOMAIN set)", () => {
  beforeEach(() => {
    process.env.ORGANISATION_DOMAIN = "board-planner.test";
    process.env.OPENROUTER_API_KEY = "sk-operators";
    process.env.OPENAI_API_KEY = "sk-operators-openai";
  });

  it("is refused the operator's key on Free, and told a plan would do", async () => {
    organisationOn("free");

    expect(await resolveModelKey(dbWith(null), "openrouter")).toEqual({ ok: false, reason: "needs_plan", plan: "free" });
    expect(await resolveModelKey(dbWith(null), "openai")).toEqual({ ok: false, reason: "needs_plan", plan: "free" });
  });

  it("may use the operator's key on Pro, which is also what a trial is", async () => {
    organisationOn("pro");

    expect(await resolveModelKey(dbWith(null), "openrouter")).toEqual({ ok: true, key: "sk-operators", source: "managed" });
  });

  it("uses its own key on Free, uncapped by anything here and never the operator's", async () => {
    organisationOn("free");
    const own = encryptSecret("sk-own", ORGANISATION);

    const result = await resolveModelKey(dbWith({ openrouterKey: own }), "openrouter");

    expect(result).toEqual({ ok: true, key: "sk-own", source: "own" });
  });

  it("keeps the two providers apart: an OpenRouter key does not open OpenAI", async () => {
    organisationOn("free");
    const own = encryptSecret("sk-own", ORGANISATION);

    expect(await resolveModelKey(dbWith({ openrouterKey: own }), "openai")).toMatchObject({
      ok: false,
      reason: "needs_plan",
    });
  });

  it("never falls back to the operator's key when its own cannot be read, not even on Pro", async () => {
    organisationOn("pro");
    const copiedFromElsewhere = encryptSecret("sk-someone-elses", OTHER);

    expect(await resolveModelKey(dbWith({ openrouterKey: copiedFromElsewhere }), "openrouter")).toEqual({
      ok: false,
      reason: "own_key_unreadable",
      plan: "pro",
    });
  });

  it("says not configured, not needs a plan, when the operator has no key to offer", async () => {
    organisationOn("free");
    delete process.env.OPENROUTER_API_KEY;

    expect(await resolveModelKey(dbWith(null), "openrouter")).toMatchObject({ ok: false, reason: "not_configured" });
  });
});

describe("what a refusal says", () => {
  it("answers a plan refusal with 402 and the two ways out", () => {
    const refusal = { ok: false, reason: "needs_plan", plan: "free" } as const;

    const { status, error } = describeModelKeyRefusal(refusal, { error: "unused", status: 503 });

    expect(status).toBe(402);
    expect(error).toMatch(/your own key/);
    expect(error).toMatch(/upgrade to Pro/);
  });

  it("leaves the caller's own wording for an unconfigured instance", () => {
    const refusal = { ok: false, reason: "not_configured", plan: "free" } as const;

    expect(describeModelKeyRefusal(refusal, { error: "PM is off", status: 503 })).toEqual({ error: "PM is off", status: 503 });
  });
});
