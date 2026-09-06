import { describe, it, expect } from "vitest";
import { PM_TOOLS, refuseUndeclaredArgs } from "./tools";

describe("a PM tool argument the tool does not declare", () => {
  it("is named in the refusal, and pointed somewhere when there is somewhere", () => {
    const said = refuseUndeclaredArgs(PM_TOOLS.update_task, { taskKey: "BP-1", status: "done" });

    expect(said).toContain("status");
    expect(said).toContain("change_status");
  });

  it("says nothing about a call that names only what the tool declares", () => {
    expect(refuseUndeclaredArgs(PM_TOOLS.update_task, { taskKey: "BP-1", title: "x" })).toBeNull();
  });

  it("claims nothing was written only where something could have been", () => {
    const write = refuseUndeclaredArgs(PM_TOOLS.update_task, { taskKey: "BP-1", stray: 1 });
    const read = refuseUndeclaredArgs(PM_TOOLS.list_tasks, { stray: 1 });

    expect(write).toContain("Nothing was written");
    expect(read).toContain("stray");
    expect(read).not.toContain("Nothing was written");
  });

  it("does not render Object.prototype for an argument named after it", () => {
    const said = refuseUndeclaredArgs(PM_TOOLS.update_task, JSON.parse('{"toString":1}'));

    expect(said).toContain("toString");
    expect(said).not.toContain("native code");
  });

  it("is advertised by every tool's schema, not only enforced", () => {
    const names = Object.keys(PM_TOOLS);

    expect(names.length).toBeGreaterThanOrEqual(10);

    const loose = names.filter(
      (name) =>
        (PM_TOOLS[name].definition.parameters as { additionalProperties?: unknown })
          .additionalProperties !== false
    );

    expect(loose).toEqual([]);
  });
});
