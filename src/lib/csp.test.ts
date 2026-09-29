import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { contentSecurityPolicy, generateNonce } from "./csp";

function directive(policy: string, name: string): string {
  return policy.split("; ").find((d) => d.split(" ")[0] === name)!;
}

async function proxied(path = "/projects", headers: Record<string, string> = {}) {
  vi.resetModules();
  const { proxy } = await import("../proxy");
  return proxy(new NextRequest(`https://app.example.com${path}`, { headers }));
}

function forwardedRequestHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the page Content-Security-Policy", () => {
  it("allows scripts by nonce, never by being inline, in production", () => {
    expect(directive(contentSecurityPolicy({ nonce: "abc", dev: false }), "script-src")).toBe(
      "script-src 'self' 'nonce-abc' 'strict-dynamic'"
    );
  });

  it("adds eval in development only", () => {
    expect(directive(contentSecurityPolicy({ nonce: "abc", dev: true }), "script-src")).toBe(
      "script-src 'self' 'nonce-abc' 'strict-dynamic' 'unsafe-eval'"
    );
  });

  it("keeps every other directive as it was before the nonce", () => {
    const policy = contentSecurityPolicy({ nonce: "abc", dev: false });
    expect(policy.split("; ").filter((d) => !d.startsWith("script-src"))).toEqual([
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src * data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "report-uri /api/csp-report",
      "report-to csp-endpoint",
    ]);
    expect(contentSecurityPolicy({ nonce: "abc", dev: true }).replace(" 'unsafe-eval'", "")).toBe(policy);
  });

  it("drops strict-dynamic when there is no nonce, since it would refuse 'self' too", () => {
    expect(directive(contentSecurityPolicy({ dev: false }), "script-src")).toBe("script-src 'self'");
  });

  it("draws a fresh, unguessable nonce each time", () => {
    const nonces = new Set(Array.from({ length: 50 }, generateNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe("the proxy", () => {
  it("serves a nonce policy and hands the same nonce to the render", async () => {
    const response = await proxied();
    const policy = response.headers.get("content-security-policy")!;
    const nonce = forwardedRequestHeader(response, "x-nonce")!;
    expect(nonce).toBeTruthy();
    expect(directive(policy, "script-src")).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(forwardedRequestHeader(response, "content-security-policy")).toBe(policy);
    expect(response.headers.get("reporting-endpoints")).toBe('csp-endpoint="/api/csp-report"');
  });

  it("never reuses a nonce between two requests", async () => {
    const a = forwardedRequestHeader(await proxied(), "x-nonce");
    const b = forwardedRequestHeader(await proxied(), "x-nonce");
    expect(a).not.toBe(b);
  });

  it("overwrites an x-nonce the client sent", async () => {
    const response = await proxied("/login", { "x-nonce": "attacker" });
    expect(forwardedRequestHeader(response, "x-nonce")).not.toBe("attacker");
  });

  it("adds eval only under a development server", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect((await proxied()).headers.get("content-security-policy")).toContain("'unsafe-eval'");
    vi.stubEnv("NODE_ENV", "production");
    expect((await proxied()).headers.get("content-security-policy")).not.toContain("'unsafe-eval'");
  });

  it("covers every page and leaves API routes and build assets alone", async () => {
    const { config } = await import("../proxy");
    const source = new RegExp(`^${config.matcher[0].source}$`);
    for (const page of ["/", "/login", "/projects/abc/tasks/def", "/settings/tokens", "/oauth/authorize"]) {
      expect(source.test(page), page).toBe(true);
    }
    for (const skipped of [
      "/api/tasks",
      "/api/csp-report",
      "/_next/static/chunks/a.js",
      "/_next/image",
      "/favicon.ico",
    ]) {
      expect(source.test(skipped), skipped).toBe(false);
    }
  });
});

describe("the API Content-Security-Policy in next.config", () => {
  async function headersFor(source: string, nodeEnv: string) {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.resetModules();
    const config = (await import("../../next.config")).default;
    return (await config.headers!()).find((h) => h.source === source)!.headers;
  }

  it("gives API responses a policy with no inline scripts and no eval in production", async () => {
    const csp = (await headersFor("/api/:path*", "production")).find(
      (h) => h.key === "Content-Security-Policy"
    )!.value;
    expect(directive(csp, "script-src")).toBe("script-src 'self'");
  });

  it("leaves the page policy to the proxy, so a page is never served two", async () => {
    const page = await headersFor("/:path*", "production");
    expect(page.map((h) => h.key)).toEqual([
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Strict-Transport-Security",
    ]);
  });
});
