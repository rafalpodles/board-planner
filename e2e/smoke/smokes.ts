/**
 * Live smoke tests of the processes the app ships beside itself (BP-711), each a Playwright project
 * in playwright.smoke.config.ts and a CI job of its own — outside GROUPS, because one of them needs
 * macOS and neither should hold up the main suite. `groups.test.ts` checks both lists.
 */
export const SMOKES = {
  "mcp-stdio": "mcp-stdio.smoke.ts",
  worker: "worker.smoke.ts",
} as const;
