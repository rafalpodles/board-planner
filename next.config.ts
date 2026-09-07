import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next paints its dev indicator over the bottom-left of every page, which on a phone is where a
  // bottom sheet puts a left-aligned action row: a real click there lands on the indicator, and
  // the suite runs `next dev`, not `next start` (BP-589). Withheld from the suite only — a
  // developer keeps the indicator and the DevTools entry point it carries.
  ...(process.env.E2E === "1" ? { devIndicators: false as const } : {}),
  // Next refuses to support `next start` against standalone output, and Railway deploys that way.
  // Only the Docker build asks for the minimal server, and it runs it directly.
  output: process.env.BUILD_STANDALONE ? "standalone" : undefined,

  // CP-160 moved these under /settings; the old paths are in bookmarks and browser history
  async redirects() {
    return [
      { source: "/profile", destination: "/settings/profile", permanent: false },
      { source: "/tokens", destination: "/settings/tokens", permanent: false },
      { source: "/users", destination: "/settings/users", permanent: false },
      { source: "/admin/agents", destination: "/settings/agents", permanent: false },
      { source: "/admin/workers", destination: "/settings/workers", permanent: false },
    ];
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // includeSubDomains, so a sibling subdomain cannot be served over plain HTTP and used
          // to shadow a cookie. No preload: it is hard to undo and is the deployment's call.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          // The audit found no XSS — the markdown pipeline is genuinely safe — so this is defence
          // in depth. img-src is deliberately left open: a tracking pixel in a task description and
          // a legitimately hotlinked screenshot are the same request, and choosing between them is
          // a product decision, not a hardening one (BP-306).
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // `unsafe-eval` in development only, and never in a production build: React's dev
              // build uses eval() to reconstruct call stacks that came from another environment,
              // so without it every page logs a console error and the debugging features it names
              // are simply off. The production bundle never calls eval, so nothing is loosened
              // where it would matter.
              process.env.NODE_ENV === "development"
                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
                : "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src * data: blob:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "form-action 'self'",
              "base-uri 'self'",
              "object-src 'none'",
            ].join("; "),
          },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "Vary", value: "Cookie" },
        ],
      },
    ];
  },
};

export default nextConfig;
