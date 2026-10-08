import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type { Plan } from "./entitlements";

const getOrganisation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/organisation", () => ({ getOrganisation }));

const { encryptSecret } = await import("./encryption");
const { describeModelKeyRefusal, forgetManagedPlans, modelKeyAvailability, modelKeyRefusalResponse, resolveModelKey } = await import("./model-keys");

const ORGANISATION = new Types.ObjectId();
const OTHER = new Types.ObjectId();

function dbWith(settings: { openrouterKey?: string } | null) {
  return {
    organisation: ORGANISATION,
    Settings: { findOne: () => ({ lean: async () => settings }) },
  } as never;
}

function organisationOn(plan: Plan) {
  getOrganisation.mockResolvedValue({ entitlements: { plan, features: [], source: "service" } });
}

const ENV = ["ORGANISATION_DOMAIN", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ENCRYPTION_KEY"] as const;

beforeEach(() => {
  for (const name of ENV) delete process.env[name];
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  getOrganisation.mockReset();
  forgetManagedPlans();
});
afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

describe("a self-hosted instance (no ORGANISATION_DOMAIN)", () => {
  it("uses the instance's key: it is the customer's own", async () => {
    process.env.OPENROUTER_API_KEY = "sk-instance";

    expect(await resolveModelKey(dbWith(null))).toEqual({ ok: true, key: "sk-instance", source: "instance" });
    expect(getOrganisation).not.toHaveBeenCalled();
  });

  it("answers not configured when there is no key anywhere", async () => {
    expect(await resolveModelKey(dbWith(null))).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("does not take OpenAI's key for it: both features run on OpenRouter now", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-old";

    expect(await resolveModelKey(dbWith(null))).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("prefers a key the organisation stored over the environment's", async () => {
    process.env.OPENROUTER_API_KEY = "sk-instance";
    const own = encryptSecret("sk-own", ORGANISATION);

    expect(await resolveModelKey(dbWith({ openrouterKey: own }))).toEqual({
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
  });

  it("is refused the operator's key on Free, and told a plan would do", async () => {
    organisationOn("free");

    expect(await resolveModelKey(dbWith(null))).toEqual({ ok: false, reason: "needs_plan", plan: "free" });
    expect(await resolveModelKey(dbWith(null))).toEqual({ ok: false, reason: "needs_plan", plan: "free" });
  });

  it("may use the operator's key on Pro, which is also what a trial is", async () => {
    organisationOn("pro");

    expect(await resolveModelKey(dbWith(null))).toEqual({ ok: true, key: "sk-operators", source: "managed" });
  });

  it("uses its own key on Free, and never the operator's", async () => {
    organisationOn("free");
    const own = encryptSecret("sk-own", ORGANISATION);

    const result = await resolveModelKey(dbWith({ openrouterKey: own }));

    expect(result).toEqual({ ok: true, key: "sk-own", source: "own" });
  });

  it("never falls back to the operator's key when its own cannot be read, not even on Pro", async () => {
    organisationOn("pro");
    const copiedFromElsewhere = encryptSecret("sk-someone-elses", OTHER);

    expect(await resolveModelKey(dbWith({ openrouterKey: copiedFromElsewhere }))).toEqual({
      ok: false,
      reason: "own_key_unreadable",
      plan: "pro",
    });
  });

  it("says not configured, not needs a plan, when the operator has no key to offer", async () => {
    organisationOn("free");
    delete process.env.OPENROUTER_API_KEY;

    expect(await resolveModelKey(dbWith(null))).toMatchObject({ ok: false, reason: "not_configured" });
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

describe("what the screens are told (modelKeyAvailability)", () => {
  it("says a self-hosted server runs where it has a key, and reads nothing about a plan", async () => {
    process.env.OPENROUTER_API_KEY = "sk-instance";

    expect(await modelKeyAvailability(dbWith(null))).toEqual({ available: true, needsPlan: false, unreadable: false });
    expect(getOrganisation).not.toHaveBeenCalled();
  });

  it("says a stored key that opens runs, and one that does not is unreadable rather than missing", async () => {
    const readable = encryptSecret("sk-own", ORGANISATION);
    const copied = encryptSecret("sk-someone-elses", OTHER);

    expect(await modelKeyAvailability(dbWith({ openrouterKey: readable }))).toEqual({ available: true, needsPlan: false, unreadable: false });
    expect(await modelKeyAvailability(dbWith({ openrouterKey: copied }))).toEqual({ available: false, needsPlan: false, unreadable: true });
  });

  describe("in the cloud", () => {
    beforeEach(() => {
      process.env.ORGANISATION_DOMAIN = "board-planner.test";
      process.env.OPENROUTER_API_KEY = "sk-operators";
    });

    it("says a Free organisation would run with a plan, and a Pro one runs", async () => {
      organisationOn("free");
      expect(await modelKeyAvailability(dbWith(null))).toEqual({ available: false, needsPlan: true, unreadable: false });

      forgetManagedPlans();
      organisationOn("pro");
      expect(await modelKeyAvailability(dbWith(null))).toEqual({ available: true, needsPlan: false, unreadable: false });
    });

    it("does not say a plan would help when the operator has no key to give", async () => {
      organisationOn("free");
      delete process.env.OPENROUTER_API_KEY;

      expect(await modelKeyAvailability(dbWith(null))).toEqual({ available: false, needsPlan: false, unreadable: false });
    });

    it("remembers the plan for a few seconds, so a board that polls does not read the organisation each time, and then asks again", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        organisationOn("free");
        await modelKeyAvailability(dbWith(null));
        await modelKeyAvailability(dbWith(null));
        expect(getOrganisation).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + 11_000);
        organisationOn("pro");
        expect(await modelKeyAvailability(dbWith(null))).toMatchObject({ available: true });
        expect(getOrganisation).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never lets that memory stand in for a call: a key is resolved against the plan as it is now", async () => {
      organisationOn("pro");
      await modelKeyAvailability(dbWith(null));

      organisationOn("free");

      expect(await resolveModelKey(dbWith(null))).toMatchObject({ ok: false, reason: "needs_plan" });
    });

    it("keeps one organisation's plan from answering for another", async () => {
      organisationOn("pro");
      await modelKeyAvailability(dbWith(null));
      organisationOn("free");
      const other = { organisation: OTHER, Settings: { findOne: () => ({ lean: async () => null }) } } as never;

      expect(await modelKeyAvailability(other)).toMatchObject({ available: false, needsPlan: true });
    });
  });
});

describe("what a refusal says, beyond the plan", () => {
  it("tells a hosted organisation to add its own key, not to set an environment variable", () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.test";
    const refusal = { ok: false, reason: "not_configured", plan: "free" } as const;

    const { error, status } = describeModelKeyRefusal(refusal, { error: "Set OPENROUTER_API_KEY", status: 501 });

    expect(error).toMatch(/Settings → AI key/);
    expect(error).not.toMatch(/OPENROUTER_API_KEY/);
    expect(status).toBe(501);
  });

  it("names the refusal in the body, so a screen can tell a plan from a key it cannot read", async () => {
    const plan = modelKeyRefusalResponse({ ok: false, reason: "needs_plan", plan: "free" }, { error: "x", status: 503 });
    const unreadable = modelKeyRefusalResponse({ ok: false, reason: "own_key_unreadable", plan: "pro" }, { error: "x", status: 503 });

    expect(plan.status).toBe(402);
    expect(await plan.json()).toMatchObject({ reason: "needs_plan", feature: "ai.managed", plan: "free" });
    expect(unreadable.status).toBe(503);
    expect(await unreadable.json()).toMatchObject({ reason: "own_key_unreadable" });
  });
});
