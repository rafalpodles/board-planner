import { describe, expect, it } from "vitest";
import { GROUP_NAMES } from "./groups.ts";
import { computeAffectedGroups } from "./affected-groups.ts";

describe("computeAffectedGroups", () => {
  it("returns nothing for an empty diff", () => {
    expect(computeAffectedGroups([])).toEqual([]);
  });

  it("narrows to the one group an owned path maps to", () => {
    expect(computeAffectedGroups(["src/components/kanban/Board.tsx"])).toEqual(["board"]);
  });

  it("unions groups across several owned paths, in group order", () => {
    expect(
      computeAffectedGroups(["src/components/kanban/Board.tsx", "src/app/login/page.tsx"])
    ).toEqual(["board", "people"]);
  });

  it("matches the longest owned prefix, not just any ancestor", () => {
    expect(computeAffectedGroups(["src/app/api/projects/[projectId]/tasks/route.ts"])).toEqual([
      "tasks",
    ]);
    expect(computeAffectedGroups(["src/app/api/projects/[projectId]/audit/route.ts"])).toEqual([
      "project",
    ]);
  });

  it("prefers the more specific entry even when the general one is listed first in the table", () => {
    // src/app/(app)/settings/ (-> project) is listed before src/app/(app)/settings/workers/
    // (-> automation, people) on purpose, so this proves the sort-by-length rule and not array
    // order: a naive "first match wins" would return ["project"] here instead.
    expect(computeAffectedGroups(["src/app/(app)/settings/workers/page.tsx"])).toEqual([
      "people",
      "automation",
    ]);
  });

  it("orders the result canonically, not by discovery order", () => {
    // src/app/login/ (-> people) is discovered before src/components/kanban/ (-> board) here,
    // but board comes before people in GROUP_NAMES.
    expect(
      computeAffectedGroups(["src/app/login/page.tsx", "src/components/kanban/Board.tsx"])
    ).toEqual(["board", "people"]);
  });

  it("runs only the group a single changed spec belongs to", () => {
    expect(computeAffectedGroups(["e2e/kanban-board-core.spec.ts"])).toEqual(["board"]);
  });

  it("falls back to every group for a spec no longer listed in any group", () => {
    // Guards against e2e/groups.ts and the actual spec files drifting apart — a renamed or
    // deleted-then-recreated spec must not silently run in zero CI jobs.
    expect(computeAffectedGroups(["e2e/a-spec-not-in-any-group.spec.ts"])).toEqual([
      ...GROUP_NAMES,
    ]);
  });

  it("falls back to every group for a shared/critical path", () => {
    expect(computeAffectedGroups(["src/lib/auth.ts"])).toEqual([...GROUP_NAMES]);
    expect(computeAffectedGroups(["package.json"])).toEqual([...GROUP_NAMES]);
    expect(computeAffectedGroups([".github/workflows/ci.yml"])).toEqual([...GROUP_NAMES]);
  });

  it("falls back to every group for components mounted in the global app layout", () => {
    // SearchLayer/SearchTrigger and PmChatWidget both mount in src/app/(app)/layout.tsx, so they
    // render — and could break — on every authenticated page, not just their "home" group.
    expect(computeAffectedGroups(["src/components/search/SearchLayer.tsx"])).toEqual([
      ...GROUP_NAMES,
    ]);
    expect(computeAffectedGroups(["src/components/pm/PmChatWidget.tsx"])).toEqual([...GROUP_NAMES]);
  });

  it("adds board for a components/tasks/ file, since kanban reuses those components", () => {
    expect(computeAffectedGroups(["src/components/tasks/detail/atoms.tsx"])).toEqual([
      "tasks",
      "task-fields",
      "board",
    ]);
  });

  it("adds project for the task panels whose failed reads failed-read-states.spec.ts pins", () => {
    for (const file of [
      "src/components/tasks/Comments.tsx",
      "src/components/tasks/ActivityTimeline.tsx",
      "src/components/tasks/TaskActivityPanel.tsx",
    ]) {
      expect(computeAffectedGroups([file])).toEqual(["tasks", "task-fields", "board", "project"]);
    }
  });

  it("adds project for the two board components a settings spec reads back from", () => {
    expect(computeAffectedGroups(["src/components/kanban/BoardFilters.tsx"])).toEqual(["board", "project"]);
    expect(computeAffectedGroups(["src/components/kanban/BoardHeader.tsx"])).toEqual(["board", "project"]);
  });

  it("falls back to every group for a non-spec e2e helper file", () => {
    expect(computeAffectedGroups(["e2e/api.ts"])).toEqual([...GROUP_NAMES]);
    expect(computeAffectedGroups(["e2e/groups.ts"])).toEqual([...GROUP_NAMES]);
  });

  it("falls back to every group for a path the table has no opinion on", () => {
    expect(computeAffectedGroups(["worker/src/agent/run.ts"])).toEqual([...GROUP_NAMES]);
  });
});
