export const TERMS_URL = "https://board-planner.com/legal/terms";

export function legalSeller(env: Record<string, string | undefined> = process.env): { name: string; address: string } | null {
  const name = env.LEGAL_SELLER_NAME?.trim();
  const address = env.LEGAL_SELLER_ADDRESS?.trim();
  return name && address ? { name, address } : null;
}

export function termsVersionInForce(env: Record<string, string | undefined> = process.env): string | null {
  const version = env.LEGAL_TERMS_VERSION?.trim();
  return version && /^[\x21-\x7e]{1,64}$/.test(version) ? version : null;
}
