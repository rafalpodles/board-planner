export const TERMS_URL = "https://board-planner.com/legal/terms";

export function termsVersionInForce(env: Record<string, string | undefined> = process.env): string | null {
  const version = env.LEGAL_TERMS_VERSION?.trim();
  return version && /^[\x21-\x7e]{1,64}$/.test(version) ? version : null;
}
