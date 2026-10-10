import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TERMS_REFUSAL,
  assertLegalTermsConfig,
  checkTermsAccepted,
  legalTerms,
  legalTermsWarning,
  termsChangeUnseen,
} from "./legal-terms";

const VERSION = "2026-10-15";

function cloud() {
  vi.stubEnv("ORGANISATION_DOMAIN", "board-planner.example");
  vi.stubEnv("LEGAL_TERMS_VERSION", VERSION);
}

afterEach(() => vi.unstubAllEnvs());

describe("the gate (BP-939)", () => {
  it.each([
    ["neither", {}],
    ["only LEGAL_TERMS_VERSION", { LEGAL_TERMS_VERSION: VERSION }],
    ["only ORGANISATION_DOMAIN", { ORGANISATION_DOMAIN: "board-planner.example" }],
  ])("is off with %s", (_, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    expect(legalTerms()).toBeNull();
  });

  it("is on with both ORGANISATION_DOMAIN and LEGAL_TERMS_VERSION", () => {
    cloud();
    expect(legalTerms()).toEqual({
      version: VERSION,
      terms: "https://board-planner.com/legal/terms",
      privacy: "https://board-planner.com/legal/privacy",
      termsPl: "https://board-planner.com/legal/terms/pl",
      privacyPl: "https://board-planner.com/legal/privacy/pl",
    });
  });

  it("warns when a self-hosted instance sets a version it will never show", () => {
    vi.stubEnv("LEGAL_TERMS_VERSION", VERSION);
    expect(legalTermsWarning()).toMatch(/ignored without ORGANISATION_DOMAIN/);
    cloud();
    expect(legalTermsWarning()).toBeNull();
  });

  it.each(["2026-10-15", " 2026-02-28 "])("takes %s at boot", (value) => {
    vi.stubEnv("LEGAL_TERMS_VERSION", value);
    expect(() => assertLegalTermsConfig()).not.toThrow();
  });

  it("names the value it validated, trimmed, when it stops the boot", () => {
    vi.stubEnv("LEGAL_TERMS_VERSION", "  v2  ");
    expect(() => assertLegalTermsConfig()).toThrow('got "v2"');
  });

  it.each(["v2", "2026-13-01", "2026-02-30", "15-10-2026", "2026-10-15T00:00"])("stops the boot on %s", (value) => {
    vi.stubEnv("LEGAL_TERMS_VERSION", value);
    expect(() => assertLegalTermsConfig()).toThrow(/LEGAL_TERMS_VERSION/);
  });
});

describe("checkTermsAccepted (BP-939)", () => {
  it.each([undefined, false, "true", 1, null])("refuses %j while the gate is on", (value) => {
    cloud();
    expect(checkTermsAccepted(value)).toEqual({ ok: false, error: TERMS_REFUSAL });
  });

  it("stamps the current version and the time on true", () => {
    cloud();
    const now = new Date("2026-10-20T10:00:00Z");
    expect(checkTermsAccepted(true, now)).toEqual({ ok: true, fields: { termsAcceptedVersion: VERSION, termsAcceptedAt: now } });
  });

  it("asks nothing and stamps nothing while the gate is off", () => {
    vi.stubEnv("LEGAL_TERMS_VERSION", VERSION);
    expect(checkTermsAccepted(undefined)).toEqual({ ok: true, fields: {} });
    expect(checkTermsAccepted(true)).toEqual({ ok: true, fields: {} });
  });
});

describe("termsChangeUnseen (BP-939)", () => {
  it("tells a person who neither accepted nor saw the current version", () => {
    cloud();
    expect(termsChangeUnseen({ kind: "human" })).toBe(true);
    expect(termsChangeUnseen({ kind: "human", termsAcceptedVersion: "2026-01-01" })).toBe(true);
    expect(termsChangeUnseen({ kind: "human", termsAcceptedVersion: "2026-01-01", termsNotifiedVersion: "2026-05-01" })).toBe(true);
  });

  it("is quiet once the current version was accepted, or its change seen", () => {
    cloud();
    expect(termsChangeUnseen({ kind: "human", termsAcceptedVersion: VERSION })).toBe(false);
    expect(termsChangeUnseen({ kind: "human", termsAcceptedVersion: "2026-01-01", termsNotifiedVersion: VERSION })).toBe(false);
  });

  it("never tells a machine", () => {
    cloud();
    expect(termsChangeUnseen({ kind: "machine" })).toBe(false);
  });

  it("tells nobody while the gate is off", () => {
    vi.stubEnv("LEGAL_TERMS_VERSION", VERSION);
    expect(termsChangeUnseen({ kind: "human" })).toBe(false);
  });
});
