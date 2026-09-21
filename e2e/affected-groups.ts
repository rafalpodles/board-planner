/**
 * Maps a changed file to the e2e/groups.ts group(s) it can affect, so CI only has to run those
 * Playwright projects instead of all six (BP CI speed-up, September 2026). Consumed by
 * scripts/plan-e2e-groups.ts, which turns the answer into the `plan-e2e` job's output.
 *
 * A path matches the longest OWNED prefix it has an entry for. Coverage here is deliberately
 * coarse (group-level, not spec-level) and deliberately incomplete: anything not covered by OWNED,
 * and anything listed in CRITICAL_PREFIXES, means "this table can't narrow it down" — and
 * computeAffectedGroups answers with every group rather than guess. Wrong in the direction of
 * running more tests than needed is a slower CI run; wrong the other way is a missed regression,
 * so ambiguity always resolves to "all".
 */
import { GROUPS, GROUP_NAMES, type GroupName } from "./groups.ts";

const OWNED: readonly { prefix: string; groups: readonly GroupName[] }[] = [
  // Components — search/, pm/ and settings/ are NOT here: SearchLayer, SearchTrigger and
  // PmChatWidget mount in the global src/app/(app)/layout.tsx (already critical), and
  // src/components/settings/ is shared by every instance settings page's chrome *and* half of
  // project settings' section components (TaskFieldsSection, WorkersSection, PmAgentSection,
  // BoardSection, ...) — traced via a real import-grep, not guessed. All three moved to
  // CRITICAL_PREFIXES below rather than chase their true footprint file by file.
  { prefix: "src/components/kanban/", groups: ["board"] },
  { prefix: "src/components/sprints/", groups: ["board"] },
  // Also imported by kanban/TaskCard.tsx, ProjectBoardView.tsx and ListView.tsx (board renders task
  // cards using these) — verified via grep, not assumed from the directory name alone.
  { prefix: "src/components/tasks/", groups: ["tasks", "task-fields", "board"] },
  { prefix: "src/components/tasks/GitlabActivity", groups: ["tasks", "task-fields", "board", "project"] },

  // Pages — nested, more specific project subpages before the bare project route
  { prefix: "src/app/(app)/projects/[projectId]/tasks/", groups: ["tasks"] },
  { prefix: "src/app/(app)/projects/[projectId]/sprints/", groups: ["board"] },
  // Automation too: the PM, MCP and worker sections of project settings are driven by its specs
  { prefix: "src/app/(app)/projects/[projectId]/settings/", groups: ["project", "automation"] },
  { prefix: "src/app/(app)/projects/[projectId]/dashboard/", groups: ["project"] },
  { prefix: "src/app/(app)/projects/[projectId]/pm/", groups: ["automation"] },
  { prefix: "src/app/(app)/projects/[projectId]/@modal/", groups: ["tasks"] },
  { prefix: "src/app/(app)/projects/[projectId]/", groups: ["board"] },
  { prefix: "src/app/(app)/projects/new/", groups: ["project"] },
  { prefix: "src/app/(app)/projects/", groups: ["project"] },
  { prefix: "src/app/(app)/agents/", groups: ["project"] },
  { prefix: "src/app/(app)/my-tasks/", groups: ["project"] },
  { prefix: "src/app/(app)/notifications/", groups: ["automation"] },
  { prefix: "src/app/(app)/search/", groups: ["task-fields"] },
  // The bare settings/ catch-all is listed before its own more specific children on purpose — it
  // exercises the longest-prefix rule against a real, non-coincidental case (e2e/affected-groups.test.ts
  // asserts settings/workers/ still resolves to its own entry, not this one, despite array order).
  // Every child below was checked individually against grep -l "/settings/<name>" e2e/*.spec.ts —
  // admin-only-screens.spec.ts's own SCREENS sweep covers only users/email/agents/workers/audit, not
  // every settings page, so it is a partial signal here, never the whole story for any one of them.
  { prefix: "src/app/(app)/settings/", groups: ["project"] },
  { prefix: "src/app/(app)/settings/workers/", groups: ["automation", "people"] },
  { prefix: "src/app/(app)/settings/agents/", groups: ["project", "automation", "people"] },
  { prefix: "src/app/(app)/settings/profile/", groups: ["people", "project", "automation"] },
  { prefix: "src/app/(app)/settings/users/", groups: ["people", "automation"] },
  { prefix: "src/app/(app)/settings/email/", groups: ["people", "project"] },
  { prefix: "src/app/(app)/settings/audit/", groups: ["project", "people", "automation"] },
  { prefix: "src/app/(app)/settings/notifications/", groups: ["automation"] },
  { prefix: "src/app/(app)/settings/tokens/", groups: ["board", "project"] },
  { prefix: "src/app/(app)/settings/security/", groups: ["project", "people"] },
  { prefix: "src/app/(app)/settings/preferences/", groups: ["project"] },

  { prefix: "src/app/login/", groups: ["people"] },
  { prefix: "src/app/forgot/", groups: ["people"] },
  { prefix: "src/app/reset/", groups: ["people"] },
  { prefix: "src/app/confirm-email/", groups: ["people"] },
  { prefix: "src/app/enrol/", groups: ["people"] },
  { prefix: "src/app/oauth/", groups: ["people"] },

  // API routes
  { prefix: "src/app/api/projects/[projectId]/tasks/", groups: ["tasks"] },
  { prefix: "src/app/api/projects/[projectId]/tasks/[taskId]/gitlab-activity/", groups: ["tasks", "project"] },
  { prefix: "src/app/api/projects/[projectId]/sprints/", groups: ["board"] },
  { prefix: "src/app/api/projects/[projectId]/custom-fields/", groups: ["task-fields"] },
  { prefix: "src/app/api/projects/[projectId]/ai/", groups: ["task-fields"] },
  { prefix: "src/app/api/projects/[projectId]/pm/", groups: ["automation"] },
  { prefix: "src/app/api/projects/[projectId]/runs/", groups: ["automation"] },
  { prefix: "src/app/api/projects/[projectId]/notifications/", groups: ["automation"] },
  { prefix: "src/app/api/projects/[projectId]/members/", groups: ["people"] },
  { prefix: "src/app/api/projects/[projectId]/assignable-users/", groups: ["people"] },
  { prefix: "src/app/api/projects/[projectId]/categories/", groups: ["tasks", "project"] },
  { prefix: "src/app/api/projects/[projectId]/agent/", groups: ["project"] },
  { prefix: "src/app/api/projects/[projectId]/audit/", groups: ["project"] },
  { prefix: "src/app/api/projects/[projectId]/github/", groups: ["project"] },
  { prefix: "src/app/api/projects/[projectId]/gitlab/", groups: ["project"] },
  { prefix: "src/app/api/projects/[projectId]/coda/", groups: ["project"] },
  { prefix: "src/app/api/projects/[projectId]/webhooks/", groups: ["project"] },
  { prefix: "src/app/api/projects/[projectId]/templates/", groups: ["project"] },
  { prefix: "src/app/api/projects/[projectId]/", groups: ["project"] },
  { prefix: "src/app/api/projects/", groups: ["project"] },
  { prefix: "src/app/api/tasks/", groups: ["tasks"] },
  { prefix: "src/app/api/search/", groups: ["task-fields"] },
  { prefix: "src/app/api/pm/", groups: ["automation"] },
  { prefix: "src/app/api/workers/", groups: ["automation"] },
  { prefix: "src/app/api/notifications/", groups: ["automation"] },
  { prefix: "src/app/api/admin/runs/", groups: ["automation"] },
  { prefix: "src/app/api/admin/workers/", groups: ["automation"] },
  { prefix: "src/app/api/admin/email/", groups: ["people"] },
  { prefix: "src/app/api/admin/", groups: ["project"] },
  { prefix: "src/app/api/agents/", groups: ["project"] },
  { prefix: "src/app/api/agent-blocks/", groups: ["project", "automation"] },
  { prefix: "src/app/api/settings/", groups: ["project"] },
  { prefix: "src/app/api/mcp/", groups: ["project"] },
  { prefix: "src/app/api/oauth/", groups: ["project"] },
  { prefix: "src/app/api/tokens/", groups: ["project"] },
  { prefix: "src/app/api/auth/", groups: ["people"] },
  { prefix: "src/app/api/users/", groups: ["people"] },
];

// A file under any of these can affect every group, so the OWNED table must not be trusted for it:
// cross-cutting lib/model/hook/UI code, the root layout, and anything that changes how the app or
// this very selection mechanism builds and runs.
const CRITICAL_PREFIXES: readonly string[] = [
  "src/lib/",
  "src/models/",
  "src/hooks/",
  "src/types/",
  "src/components/ui/",
  "src/components/shell/",
  "src/components/search/",
  "src/components/pm/",
  "src/components/settings/",
  "src/components/AuthGuard.",
  "src/components/AuthProvider.",
  "src/components/ThemeProvider.",
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/app/error.tsx",
  "src/app/globals.css",
  "src/app/(app)/layout.tsx",
  "src/app/(app)/settings/layout.tsx",
  "src/app/api/e2e/",
  "src/instrumentation.ts",
  "e2e/", // helpers, fixtures, groups.ts, this file — everything here but a *.spec.ts
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.setup.ts",
  "playwright.config.ts",
  "postcss.config.mjs",
  ".github/workflows/",
];

const SPEC_TO_GROUP = new Map<string, GroupName>();
for (const [group, specs] of Object.entries(GROUPS) as [GroupName, readonly string[]][]) {
  for (const spec of specs) SPEC_TO_GROUP.set(spec, group);
}

export function computeAffectedGroups(changedFiles: readonly string[]): GroupName[] {
  if (changedFiles.length === 0) return [];

  const groups = new Set<GroupName>();
  for (const file of changedFiles) {
    // Checked before CRITICAL_PREFIXES' blanket "e2e/" entry, so touching one spec runs only the
    // group it belongs to rather than all six.
    const specMatch = file.match(/^e2e\/([^/]+\.spec\.ts)$/);
    if (specMatch) {
      const group = SPEC_TO_GROUP.get(specMatch[1]);
      if (!group) return [...GROUP_NAMES];
      groups.add(group);
      continue;
    }

    if (CRITICAL_PREFIXES.some((prefix) => file.startsWith(prefix))) return [...GROUP_NAMES];

    const match = OWNED.filter((entry) => file.startsWith(entry.prefix)).sort(
      (a, b) => b.prefix.length - a.prefix.length
    )[0];
    if (!match) return [...GROUP_NAMES];
    match.groups.forEach((g) => groups.add(g));
  }

  return GROUP_NAMES.filter((g) => groups.has(g));
}
