import { e2eOnlyMounted } from "./e2e-only";
import { organisationDomain } from "./organisation-host";
import type { LegalTerms } from "@/types";

export type { LegalTerms };

export const TERMS_URL = "https://board-planner.com/legal/terms";
export const PRIVACY_URL = "https://board-planner.com/legal/privacy";

export const TERMS_REFUSAL = "Accept the Terms of Service and the Privacy Policy to create an account.";

export type TermsAcceptance = { termsAcceptedVersion: string; termsAcceptedAt: Date } | Record<string, never>;

const VERSION_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

declare global {
  // Survives Turbopack giving each route its own copy of this module
  var __bpE2eLegalTermsVersion: { version: string | undefined } | undefined;
}

export function setE2eLegalTermsVersion(version: string | undefined): void {
  globalThis.__bpE2eLegalTermsVersion = { version };
}

function configuredVersion(): string | null {
  const override = e2eOnlyMounted(process.env.E2E, process.env.NODE_ENV) ? globalThis.__bpE2eLegalTermsVersion : undefined;
  return (override ? override.version : process.env.LEGAL_TERMS_VERSION)?.trim() || null;
}

function isVersion(value: string): boolean {
  const match = VERSION_PATTERN.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function assertLegalTermsConfig(): void {
  const version = configuredVersion();
  if (version !== null && !isVersion(version)) {
    throw new Error(`LEGAL_TERMS_VERSION must be the date the terms took effect, as YYYY-MM-DD; got "${version}"`);
  }
}

export function legalTermsWarning(): string | null {
  return configuredVersion() !== null && !organisationDomain()
    ? "WARNING: LEGAL_TERMS_VERSION is ignored without ORGANISATION_DOMAIN: a self-hosted instance shows no cloud terms"
    : null;
}

export function legalTermsVersion(): string | null {
  return organisationDomain() ? configuredVersion() : null;
}

export function legalTerms(): LegalTerms | null {
  const version = legalTermsVersion();
  if (!version) return null;
  return { version, terms: TERMS_URL, privacy: PRIVACY_URL, termsPl: `${TERMS_URL}/pl`, privacyPl: `${PRIVACY_URL}/pl` };
}

export function checkTermsAccepted(acceptTerms: unknown, now = new Date()): { ok: true; fields: TermsAcceptance } | { ok: false; error: string } {
  const version = legalTermsVersion();
  if (!version) return { ok: true, fields: {} };
  if (acceptTerms !== true) return { ok: false, error: TERMS_REFUSAL };
  return { ok: true, fields: { termsAcceptedVersion: version, termsAcceptedAt: now } };
}
