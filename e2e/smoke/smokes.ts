/**
 * Live smoke tests of the processes the app ships beside itself (BP-711), each a Playwright project
 * in playwright.smoke.config.ts and a CI job of its own — outside GROUPS, because it needs macOS
 * and should not hold up the main suite. `groups.test.ts` checks both lists.
 */
export const SMOKES = {
  worker: "worker.smoke.ts",
} as const;
