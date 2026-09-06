import { describe, it, expect, afterEach, vi } from "vitest";

async function scriptSrc(nodeEnv: string): Promise<string> {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.resetModules();
  const config = (await import("../../next.config")).default;
  const headers = await config.headers!();
  const page = headers.find((h) => h.source === "/:path*");
  const csp = page!.headers.find((h) => h.key === "Content-Security-Policy")!.value;
  return csp.split("; ").find((d) => d.startsWith("script-src"))!;
}

describe("the Content-Security-Policy this app serves", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses eval in production", async () => {
    expect(await scriptSrc("production")).toBe("script-src 'self' 'unsafe-inline'");
  });

  it("allows it in development, where React's own debugging needs it", async () => {
    expect(await scriptSrc("development")).toBe("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
  });

  it("keeps the rest of the policy identical in both", async () => {
    const strip = (s: string) => s.replace(" 'unsafe-eval'", "");
    expect(strip(await scriptSrc("development"))).toBe(await scriptSrc("production"));
  });
});
