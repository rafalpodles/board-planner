/**
 * Whether a surface that exists only for the end-to-end suite is mounted (BP-605).
 *
 * Both conditions, and neither is a formality. `E2E` is set by `playwright.config.ts` and by
 * nothing else in this repository; `NODE_ENV` is `production` under `next start`, which is what
 * Railway and the Docker image run — so a leaked `E2E=1` still opens nothing there.
 *
 * Takes both values rather than reading `process.env` itself, which is the shape
 * `allowLoopbackIn` settled on for the same reason: vitest runs with `NODE_ENV` of "test", so a
 * test that read the ambient value could only ever observe the permissive branch, and the
 * production one would be pinned by nothing.
 */
export function e2eOnlyMounted(e2e: string | undefined, nodeEnv: string | undefined): boolean {
  return e2e === "1" && nodeEnv !== "production";
}
