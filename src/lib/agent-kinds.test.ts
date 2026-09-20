import { describe, it, expect } from "vitest";
import { GATE_KINDS, MODELS, CAPABILITIES, gateKindByKey } from "./agent-kinds";

/**
 * One list, read from two places: the settings form renders these in the browser and
 * `agent-seed.ts` builds the catalog rows from them on the server. The tests below are the
 * invariants that keep the form and the seeded row from drifting — none of them is about a
 * particular gate, and all of them break when a new one is added carelessly.
 */
describe("GATE_KINDS", () => {
  it("has a unique key per gate", () => {
    const keys = GATE_KINDS.map((k) => k.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every gate a name and a description to render", () => {
    for (const kind of GATE_KINDS) {
      expect(kind.name.trim(), kind.key).not.toBe("");
      expect(kind.description.trim(), kind.key).not.toBe("");
    }
  });

  /**
   * A parameter listed here is one the worker reads. "Also protect" and "Also count as a test"
   * were offered before either gate could act on them — a form the operator fills in and nothing
   * obeys, which is worse than not offering it (BP-343). A default for a parameter that does not
   * exist is the same mistake seen from the other end.
   */
  it("defaults nothing it does not also offer as a parameter", () => {
    let checked = 0;
    for (const kind of GATE_KINDS) {
      const params = kind.params.map((p) => p.key);
      for (const key of Object.keys(kind.defaults)) {
        expect(params, `${kind.key}.defaults.${key}`).toContain(key);
        checked += 1;
      }
    }
    // Most gates carry neither a param nor a default, so without this the loop above could run
    // no assertion at all and the test would still be green.
    expect(checked).toBeGreaterThan(0);
  });

  /**
   * A select with no default renders with nothing chosen, and the value that reaches the worker
   * is then whatever the browser picked. Free-text and number params are allowed to start empty —
   * they have a placeholder instead.
   */
  it("gives every select a default to start from", () => {
    let checked = 0;
    for (const kind of GATE_KINDS) {
      for (const param of kind.params.filter((p) => p.type === "select")) {
        expect(kind.defaults[param.key], `${kind.key}.${param.key}`).toBeDefined();
        checked += 1;
      }
    }
    expect(checked, "no select param left for this to be about").toBeGreaterThan(0);
  });

  it("gives every select some options, and every option a value and a label", () => {
    for (const kind of GATE_KINDS) {
      for (const param of kind.params.filter((p) => p.type === "select")) {
        expect(param.options?.length ?? 0, `${kind.key}.${param.key}`).toBeGreaterThan(0);
        for (const option of param.options ?? []) {
          expect(option.value, `${kind.key}.${param.key}`).toBeTruthy();
          expect(option.label, `${kind.key}.${param.key}`).toBeTruthy();
        }
      }
    }
  });

  // A default that is not one of the options is a form that opens on a value it will not let you
  // choose again once you have moved off it.
  it("defaults every select to one of its own options", () => {
    for (const kind of GATE_KINDS) {
      for (const param of kind.params.filter((p) => p.type === "select")) {
        const values = (param.options ?? []).map((o) => o.value);
        expect(values, `${kind.key}.${param.key}`).toContain(kind.defaults[param.key]);
      }
    }
  });

  it("has a unique parameter key within each gate", () => {
    for (const kind of GATE_KINDS) {
      const keys = kind.params.map((p) => p.key);
      expect(new Set(keys).size, kind.key).toBe(keys.length);
    }
  });

  // The model list is declared once so the review gate's picker and anything else offering a
  // model cannot disagree about what exists.
  it("offers the review gate exactly the models the shared list holds", () => {
    const review = gateKindByKey("review");
    const models = review?.params.find((p) => p.key === "model");

    expect(models?.options).toEqual([...MODELS]);
  });
});

describe("gateKindByKey", () => {
  it("finds a gate by its key", () => {
    expect(gateKindByKey("diff-size")?.name).toBe("Size");
  });

  it.each([
    ["a key nothing has", "no-such-gate"],
    ["an empty string", ""],
    ["a gate's name rather than its key", "Size"],
  ])("answers undefined for %s", (_name, key) => {
    expect(gateKindByKey(key)).toBeUndefined();
  });

  it("finds every gate the list holds", () => {
    for (const kind of GATE_KINDS) {
      expect(gateKindByKey(kind.key), kind.key).toBe(kind);
    }
  });
});

describe("CAPABILITIES", () => {
  // What a step may touch. The worker owns these: the UI names one, it never composes a tool list.
  it("names exactly the two the worker implements", () => {
    expect(CAPABILITIES.map((c) => c.value)).toEqual(["read-only", "edit"]);
  });

  it("gives each one a label and a hint saying what it permits", () => {
    for (const capability of CAPABILITIES) {
      expect(capability.label.trim()).not.toBe("");
      expect(capability.hint.trim()).not.toBe("");
    }
  });
});
