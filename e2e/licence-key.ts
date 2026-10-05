import { expect, type APIRequestContext } from "@playwright/test";
import { signLicence, type LicencePayload } from "../src/lib/licence";

// A keypair the suite owns. The app accepts a public key from E2E_LICENCE_PUBLIC_KEY only when
// E2E=1 and the NODE_ENV the build inlined is not "production", so under `next build` it accepts
// none, whatever the environment says — which is why the private half may sit in a public repository.
export const E2E_LICENCE_SIGNING_KEY = {
  keyId: "e2e",
  d: "DPDD3QJcNRYFnq1RAzKLeTTGW4_IRXQWZuI4_MzFDHQ",
  x: "vEbFT9_uuLTRoEHtvE_NjGiT9-oV8H-FyWNYbItXCyI",
};
export const E2E_LICENCE_PUBLIC_KEY = E2E_LICENCE_SIGNING_KEY.x;

// The licence service's request key, as the e2e organisations server lists it in PLATFORM_REQUEST_KEYS
export const E2E_PLATFORM_REQUEST_KEY = {
  keyId: "e2e-request",
  d: "4KTi2vT_bLK_AmGmLZOIi_sNQbVUcaNWx1XvCt6PQKk",
  x: "O8oCMfZiZp2tFnZpT8I5C1A4bQ95veiR9riXvLD069c",
};

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

/** Swaps the key the server reads (`POST /api/e2e/licence`); `undefined` puts it back on Free. */
export async function useLicenceKey(request: APIRequestContext, key: string | undefined) {
  const response = await request.post("/api/e2e/licence", { data: key === undefined ? {} : { key } });
  expect(response.status(), await response.text()).toBe(204);
}
