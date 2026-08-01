import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // CP-160 moved these under /settings; the old paths are in bookmarks and browser history
  async redirects() {
    return [
      { source: "/profile", destination: "/settings/profile", permanent: false },
      { source: "/tokens", destination: "/settings/tokens", permanent: false },
      { source: "/users", destination: "/settings/users", permanent: false },
      { source: "/admin/agents", destination: "/settings/agents", permanent: false },
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
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
        ],
      },
    ];
  },
};

export default nextConfig;
