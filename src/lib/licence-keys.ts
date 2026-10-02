export interface LicencePublicKey {
  keyId: string;
  // Raw Ed25519 public key, base64url — the JWK `x` member
  x: string;
}

// Adding a signing key keeps every licence the old one signed valid; removing one makes its licences
// `unknown_key`. The private halves live with the licence service, never in this repository.
export const LICENCE_PUBLIC_KEYS: readonly LicencePublicKey[] = [
  { keyId: "bp-2026-10", x: "D8MI4t3ZeANtHr3z853F-fD3o5HfHAqP1hYGL-c1YOc" },
];
