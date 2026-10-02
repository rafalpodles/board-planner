import { signLicence, type LicencePayload } from "../src/lib/licence";

// A keypair the suite owns. The app accepts its public half only where `e2eOnlyMounted` holds, so a
// licence signed with it opens nothing on a production build — which is why the private half may sit
// in a public repository.
export const E2E_LICENCE_SIGNING_KEY = {
  keyId: "e2e",
  d: "DPDD3QJcNRYFnq1RAzKLeTTGW4_IRXQWZuI4_MzFDHQ",
  x: "vEbFT9_uuLTRoEHtvE_NjGiT9-oV8H-FyWNYbItXCyI",
};
export const E2E_LICENCE_PUBLIC_KEY = E2E_LICENCE_SIGNING_KEY.x;

const DAY = 24 * 60 * 60 * 1000;

export function e2eLicence(
  overrides: Partial<Omit<LicencePayload, "v" | "keyId">> & { expiresInDays?: number } = {}
): string {
  const { expiresInDays = 365, ...payload } = overrides;
  return signLicence(
    {
      customer: "Acme E2E Ltd",
      plan: "pro",
      features: [],
      issuedAt: new Date(Date.now() - DAY).toISOString(),
      expiresAt: new Date(Date.now() + expiresInDays * DAY).toISOString(),
      ...payload,
    },
    E2E_LICENCE_SIGNING_KEY
  );
}
