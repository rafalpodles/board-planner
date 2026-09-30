// A prerendered page is built once, with no request and so no nonce, and is then served under the
// proxy's nonce policy: every script on it is refused. Each entry here is a page known to be static
// and to work that way anyway.
export const STATIC_ROUTES_ALLOWED: Record<string, string> = {
  "/_global-error": "Next's own fatal-error page (builtin/app-error.js), always prerendered; its Reload is a plain <form>",
  "/icon.svg": "an image, not a page",
};

export function unexpectedStaticRoutes(manifest: unknown): string[] {
  const { routes, dynamicRoutes } =
    (manifest as { routes?: Record<string, unknown>; dynamicRoutes?: Record<string, unknown> } | null) ?? {};
  if (!routes || typeof routes !== "object" || !dynamicRoutes || typeof dynamicRoutes !== "object") {
    throw new Error("prerender-manifest.json has no routes or dynamicRoutes table — has its shape changed?");
  }
  return [
    ...Object.keys(routes).filter((route) => !(route in STATIC_ROUTES_ALLOWED)),
    ...Object.keys(dynamicRoutes),
  ];
}
