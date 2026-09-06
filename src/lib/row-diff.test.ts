import { describe, it, expect } from "vitest";
import { diffById } from "./row-diff";

interface Row {
  _id?: string;
  name?: string;
  enabled?: boolean;
  events?: string[];
}

const a: Row = { _id: "1", name: "Releases", enabled: true };
const b: Row = { _id: "2", name: "Alerts", enabled: false };

describe("diffById", () => {
  it("finds nothing to do when the draft matches", () => {
    expect(diffById([a, b], [a, b])).toEqual({ added: [], removed: [], changed: [] });
  });

  it("treats a row with no id as added", () => {
    const fresh: Row = { name: "Ops", enabled: true };
    expect(diffById([a], [a, fresh])).toEqual({ added: [fresh], removed: [], changed: [] });
  });

  it("reports a row dropped from the draft as removed, by id", () => {
    expect(diffById([a, b], [a])).toEqual({ added: [], removed: ["2"], changed: [] });
  });

  it("reports an edited row as changed", () => {
    const edited = { ...b, enabled: true };
    expect(diffById([a, b], [a, edited])).toEqual({ added: [], removed: [], changed: [edited] });
  });

  it("ignores a pure reorder", () => {
    expect(diffById([a, b], [b, a])).toEqual({ added: [], removed: [], changed: [] });
  });

  it("compares nested values rather than object identity", () => {
    const withEvents: Row = { _id: "1", events: ["task_created"] };
    const same: Row = { _id: "1", events: ["task_created"] };
    const different: Row = { _id: "1", events: ["task_created", "status_changed"] };

    expect(diffById([withEvents], [same]).changed).toEqual([]);
    expect(diffById([withEvents], [different]).changed).toEqual([different]);
  });

  it("handles an add, a removal and an edit together", () => {
    const fresh: Row = { name: "Ops", enabled: true };
    const edited = { ...a, enabled: false };
    const diff = diffById([a, b], [edited, fresh]);

    expect(diff).toEqual({ added: [fresh], removed: ["2"], changed: [edited] });
  });
});
