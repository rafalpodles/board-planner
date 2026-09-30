export const NONCE_HEADER = "x-nonce";
export const CSP_REPORT_PATH = "/api/csp-report";
export const CSP_REPORT_GROUP = "csp-endpoint";
export const REPORTING_ENDPOINTS = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function scriptSrc(nonce: string | undefined, dev: boolean): string {
  const sources = ["'self'"];
  // 'strict-dynamic' ignores 'self', so without a nonce it would refuse every script.
  if (nonce) sources.push(`'nonce-${nonce}'`, "'strict-dynamic'");
  // React's dev build uses eval() to rebuild call stacks from the server; the production bundle never does.
  if (dev) sources.push("'unsafe-eval'");
  return `script-src ${sources.join(" ")}`;
}

export function contentSecurityPolicy({ nonce, dev }: { nonce?: string; dev: boolean }): string {
  return [
    "default-src 'self'",
    scriptSrc(nonce, dev),
    "style-src 'self' 'unsafe-inline'",
    // Left open on purpose: a tracking pixel in a task description and a hotlinked screenshot are
    // the same request, and choosing between them is a product decision (BP-306).
    "img-src * data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join("; ");
}
