/**
 * The suite, divided into groups that run as separate CI jobs.
 *
 * It is one Playwright project per group rather than `--shard`, because Playwright shards by
 * **test count**, and on this suite that is a very uneven split of minutes: on CI run 32768854540,
 * `claim-ownership` took 35s over 43 tests while `field-history` took 154s over 26. The groups
 * below are balanced on those CI durations and named for what they cover, so a new spec has an
 * obvious home.
 *
 * A spec in no group runs nowhere. `groups.test.ts` fails when one is missing, in the cheap unit
 * job rather than three minutes into an end-to-end run.
 */
export const GROUPS = {
  tasks: [
    "task-detail.spec.ts",
    "another-boards-task.spec.ts",
    "task-from-anywhere.spec.ts",
    "duplicate-opens-one-editor.spec.ts",
    "task-references.spec.ts",
    "copy-task-link.spec.ts",
    "task-header-project-link.spec.ts",
    "sticky-task-header.spec.ts",
    "task-recurrence.spec.ts",
    "task-filters.spec.ts",
    "assignee-writers.spec.ts",
    "picker-stays-open.spec.ts",
  ],
  "task-fields": [
    "field-history.spec.ts",
    "ai-task-generation.spec.ts",
    "search.spec.ts",
    "search-page.spec.ts",
  ],
  board: [
    "kanban-board-core.spec.ts",
    "task-number-not-burnt.spec.ts",
    "column-roles.spec.ts",
    "sprint-planning.spec.ts",
    "sprint-estimates.spec.ts",
    "sprints-ui.spec.ts",
    "focus-ring.spec.ts",
    "ios-focus-zoom.spec.ts",
    "board-toolbar-geometry.spec.ts",
    "board-panels-on-the-screen.spec.ts",
    "board-move-without-drag.spec.ts",
    "shortcut-help-escape.spec.ts",
    "shortcut-help-a11y.spec.ts",
    "list-columns-on-a-phone.spec.ts",
    "board-irreversible.spec.ts",
  ],
  project: [
    "project-lifecycle.spec.ts",
    "project-settings.spec.ts",
    "project-dashboard.spec.ts",
    "my-tasks.spec.ts",
    "projects-list.spec.ts",
    "project-audit-log.spec.ts",
    "sidebar-reorder.spec.ts",
    "error-boundary.spec.ts",
    "dashboard-reads-the-board.spec.ts",
    "dashboard-says-why.spec.ts",
    "instance-settings.spec.ts",
    "settings-mobile-nav.spec.ts",
    "instance-audit.spec.ts",
    "agents-catalog.spec.ts",
    "agent-editor-permissions.spec.ts",
    "compose-without-a-mouse.spec.ts",
    "agent-picker-scoping.spec.ts",
    "project-default-agent.spec.ts",
    "external-integrations.spec.ts",
    "mcp-oauth.spec.ts",
    "mcp-tools.spec.ts",
    "db-reconnect-leaks.spec.ts",
    "settings-fields-and-templates.spec.ts",
  ],
  people: [
    "day-zero.spec.ts",
    "bounded-bodies.spec.ts",
    "sessions-and-auth.spec.ts",
    "admin-sets-password.spec.ts",
    "reset-by-email.spec.ts",
    "email-on-account.spec.ts",
    "own-display-name.spec.ts",
    "user-card-names.spec.ts",
    "assignee-access.spec.ts",
    "admin-only-screens.spec.ts",
    "instance-outage.spec.ts",
  ],
  automation: [
    "workers-enrolment.spec.ts",
    "worker-controls.spec.ts",
    "worker-enrolment-name.spec.ts",
    "run-conflict.spec.ts",
    "run-completion.spec.ts",
    "claim-ownership.spec.ts",
    "in-app-notifications.spec.ts",
    "board-feed-notifications.spec.ts",
    "pm-chat.spec.ts",
    "pm-trust-boundary.spec.ts",
    "pm-assignment-is-a-handover.spec.ts",
    "pm-autonomy.spec.ts",
    "pm-what-a-turn-costs.spec.ts",
    "select-has-a-name.spec.ts",
    "removed-member-notifications.spec.ts",
  ],
} as const satisfies Record<string, readonly string[]>;

export type GroupName = keyof typeof GROUPS;

export const GROUP_NAMES = Object.keys(GROUPS) as GroupName[];
