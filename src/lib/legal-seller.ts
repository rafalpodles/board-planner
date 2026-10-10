export interface LegalSeller {
  name: string;
  address: string;
}

export const LEGAL_NOTICE_URL = "https://board-planner.com/legal/notice";
export const TERMS_URL = "https://board-planner.com/legal/terms";
export const PRIVACY_URL = "https://board-planner.com/legal/privacy";

/** The seller of the Service named before an order is placed; both or nothing (BP-941) */
export function legalSeller(env: Record<string, string | undefined> = process.env): LegalSeller | null {
  const name = env.LEGAL_SELLER_NAME?.trim();
  const address = env.LEGAL_SELLER_ADDRESS?.trim();
  return name && address ? { name, address } : null;
}

/** The version of the Terms an order accepts, as it reaches the licence service; unset, the order step names no Terms */
export function termsVersionInForce(env: Record<string, string | undefined> = process.env): string | null {
  const version = env.LEGAL_TERMS_VERSION?.trim();
  return version && /^[\x21-\x7e]{1,64}$/.test(version) ? version : null;
}
