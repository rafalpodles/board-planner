import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Types } from "mongoose";

const getOrganisation = vi.fn();
vi.mock("@/lib/organisation", () => ({ getOrganisation }));

const { providersFor, providerFor, publicProvidersFor, liveIdentityFilterFor } = await import("./providers");
const { encryptSecret } = await import("@/lib/encryption");

const ENV_KEYS = ["ORGANISATION_DOMAIN", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ENCRYPTION_KEY"];
const acme = new Types.ObjectId();
const globex = new Types.ObjectId();

const stored = (organisation: Types.ObjectId, over: Record<string, unknown> = {}) => ({
  issuer: "https://login.acme.example",
  clientId: "acme-app",
  clientSecret: encryptSecret("acme-secret", organisation),
  clientSecretHint: "cret",
  label: "Acme login",
  ...over,
});
const dbOf = (organisation: Types.ObjectId, sso: unknown) =>
  ({ organisation, Settings: { findOne: () => ({ lean: async () => (sso ? { sso } : {}) }) } }) as never;
const plan = (over: Record<string, unknown> = {}) => getOrganisation.mockResolvedValue({ entitlements: { plan: "pro", features: [], ...over } });

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  Object.assign(process.env, { ORGANISATION_DOMAIN: "board.example", OIDC_ISSUER: "https://shared.example", OIDC_CLIENT_ID: "shared", OIDC_CLIENT_SECRET: "shared-secret" });
  plan();
});
afterEach(() => {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  getOrganisation.mockReset();
});

describe("the sign-in providers of a cloud organisation (BP-951)", () => {
  it("offers its own provider with the secret it stored, and never the environment's generic one", async () => {
    const providers = await providersFor(dbOf(acme, stored(acme)));

    expect(providers).toEqual([
      { id: "oidc", kind: "oidc", linksByAddress: true, label: "Acme login", issuer: "https://login.acme.example", clientId: "acme-app", clientSecret: "acme-secret", own: true },
    ]);
    expect(providers.some((p) => p.issuer === "https://shared.example")).toBe(false);
  });

  it("offers Google beside it where the operator set Google up, and Google alone when the organisation has none", async () => {
    Object.assign(process.env, { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs" });

    expect((await providersFor(dbOf(acme, stored(acme)))).map((p) => p.id)).toEqual(["google", "oidc"]);
    expect((await providersFor(dbOf(globex, null))).map((p) => p.id)).toEqual(["google"]);
  });

  it("is a trial's too, since a trial is Pro with a date", async () => {
    plan({ trial: true, expiresAt: new Date(Date.now() + 86_400_000) });

    expect(await publicProvidersFor(dbOf(acme, stored(acme)))).toEqual([{ id: "oidc", label: "Acme login" }]);
  });

  it("is off on Free and back with the next plan, the stored setup untouched", async () => {
    const db = dbOf(acme, stored(acme));

    plan({ plan: "free" });
    expect(await providersFor(db)).toEqual([]);
    expect(await providerFor(db, "oidc")).toBeNull();

    plan();
    expect(await providerFor(db, "oidc")).toMatchObject({ clientId: "acme-app" });
  });

  it("is off when a trial has ended", async () => {
    plan({ trial: true, expiresAt: new Date(Date.now() - 1000) });

    expect(await providersFor(dbOf(acme, stored(acme)))).toEqual([]);
  });

  it("is not offered when its secret was sealed for another organisation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await providersFor(dbOf(globex, stored(acme)))).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("counts only the identities of the issuer it signs as now", async () => {
    const filter = (await liveIdentityFilterFor(dbOf(acme, stored(acme)))) as { $or: { provider: string; issuer: { $in: string[] } }[] };

    expect(filter.$or).toHaveLength(1);
    expect(filter.$or[0]).toMatchObject({ provider: "oidc" });
    expect(filter.$or[0].issuer.$in).toContain("https://login.acme.example");
    expect(filter.$or[0].issuer.$in).not.toContain("https://shared.example");
  });
});

describe("where one organisation is the whole instance", () => {
  it("is the operator's environment, as before, whatever an organisation stored", async () => {
    delete process.env.ORGANISATION_DOMAIN;

    expect((await providersFor(dbOf(acme, stored(acme)))).map((p) => p.issuer)).toEqual(["https://shared.example"]);
  });
});
