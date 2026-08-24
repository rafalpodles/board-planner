/**
 * The suite, divided into groups that run as separate CI jobs.
 *
 * It is one Playwright project per group rather than `--shard`, because Playwright shards by
 * **test count**: `claim-ownership` has 43 tests in 35 seconds and `field-history` 26 in 154, so
 * an even split of tests is a very uneven split of minutes. The groups below are balanced on
 * measured duration and named for what they cover, so a new spec has an obvious home.
 *
 * A spec in no group runs nowhere. `groups.test.ts` fails when one is missing, in the cheap unit
 * job rather than three minutes into an end-to-end run.
 */
export const GROUPS = {
  tasks: [
    "task-detail.spec.ts",
    "task-references.spec.ts",
    "copy-task-link.spec.ts",
    "task-header-project-link.spec.ts",
    "sticky-task-header.spec.ts",
  ],
  "task-fields": ["field-history.spec.ts", "ai-task-generation.spec.ts", "search.spec.ts"],
  board: [
    "kanban-board-core.spec.ts",
    "column-roles.spec.ts",
    "sprint-planning.spec.ts",
    "sprint-estimates.spec.ts",
    "focus-ring.spec.ts",
  ],
  project: [
    "project-lifecycle.spec.ts",
    "settings-save.spec.ts",
    "instance-settings.spec.ts",
    "settings-mobile-nav.spec.ts",
    "instance-audit.spec.ts",
    "external-integrations.spec.ts",
    "mcp-oauth.spec.ts",
  ],
  people: [
    "sessions-and-auth.spec.ts",
    "admin-sets-password.spec.ts",
    "reset-by-email.spec.ts",
    "email-on-account.spec.ts",
    "own-display-name.spec.ts",
    "user-card-names.spec.ts",
    "assignee-access.spec.ts",
  ],
  automation: [
    "workers-enrolment.spec.ts",
    "worker-enrolment-name.spec.ts",
    "run-conflict.spec.ts",
    "run-completion.spec.ts",
    "claim-ownership.spec.ts",
    "in-app-notifications.spec.ts",
    "board-feed-notifications.spec.ts",
    "removed-member-notifications.spec.ts",
  ],
} as const satisfies Record<string, readonly string[]>;

export type GroupName = keyof typeof GROUPS;

export const GROUP_NAMES = Object.keys(GROUPS) as GroupName[];
