import { describe, it, expect } from "vitest";
import {
  matchOptionValue,
  normalizeOptions,
  normalizeFields,
  sortedFields,
  activeFields,
  orderedOptions,
  validateCustomFieldValues,
  sanitizeCustomFieldValues,
  matchesFieldFilter,
  matchesAllFieldFilters,
  resolveFieldsByName,
  customFieldActivityChanges,
  parseOptions,
} from "./custom-fields";
import { DEFAULT_OPTION_COLOR, ICustomField } from "@/types";

function field(over: Partial<Omit<ICustomField, "_id">> & { _id: string }): ICustomField {
  return {
    name: "Owoce",
    fieldType: "dropdown",
    options: [],
    required: false,
    order: 0,
    showOnCard: false,
    showInList: false,
    filterable: false,
    archived: false,
    ...over,
  } as unknown as ICustomField;
}

describe("normalizeOptions", () => {
  it("keeps a legacy string as its own id, so stored values still match", () => {
    expect(normalizeOptions(["Apples", "Pears"])).toEqual([
      { id: "Apples", value: "Apples", color: DEFAULT_OPTION_COLOR, order: 0 },
      { id: "Pears", value: "Pears", color: DEFAULT_OPTION_COLOR, order: 1 },
    ]);
  });

  it("leaves an already-migrated option alone", () => {
    const option = { id: "opt1", value: "Renamed", color: "#ff0000", order: 3 };
    expect(normalizeOptions([option])).toEqual([option]);
  });

  it("fills a missing colour and order rather than emitting undefined", () => {
    const [option] = normalizeOptions([{ id: "opt1", value: "Apples" }]);
    expect(option.color).toBe(DEFAULT_OPTION_COLOR);
    expect(option.order).toBe(0);
  });

  it("treats a missing options list as empty", () => {
    expect(normalizeOptions(undefined)).toEqual([]);
  });
});

describe("normalizeFields", () => {
  it("gives a pre-CP-211 definition every new property with a safe default", () => {
    const [f] = normalizeFields([{ name: "Owoce", fieldType: "dropdown", options: ["Apples"] }]);
    expect(f).toMatchObject({
      required: false,
      order: 0,
      showOnCard: false,
      showInList: false,
      filterable: false,
      archived: false,
    });
    expect(f.options[0].id).toBe("Apples");
  });

  it("does not overwrite properties a field already carries", () => {
    const [f] = normalizeFields([
      { name: "X", fieldType: "number", showOnCard: true, order: 5, archived: true },
    ]);
    expect(f.showOnCard).toBe(true);
    expect(f.order).toBe(5);
    expect(f.archived).toBe(true);
  });
});

describe("ordering", () => {
  it("sorts by order and sinks archived fields below live ones", () => {
    const fields = [
      field({ _id: "a", order: 2 }),
      field({ _id: "b", order: 0, archived: true }),
      field({ _id: "c", order: 1 }),
    ];
    expect(sortedFields(fields).map((f) => f._id)).toEqual(["c", "a", "b"]);
  });

  it("drops archived fields from the active set", () => {
    const fields = [field({ _id: "a" }), field({ _id: "b", archived: true })];
    expect(activeFields(fields).map((f) => f._id)).toEqual(["a"]);
  });

  it("renders options in their configured order, not the stored one", () => {
    const f = field({
      _id: "a",
      options: [
        { id: "2", value: "Second", color: "#000", order: 1 },
        { id: "1", value: "First", color: "#000", order: 0 },
      ],
    });
    expect(orderedOptions(f).map((o) => o.value)).toEqual(["First", "Second"]);
  });
});

describe("validateCustomFieldValues", () => {
  const dropdown = field({
    _id: "d1",
    fieldType: "dropdown",
    options: [{ id: "opt1", value: "Apples", color: "#000", order: 0 }],
  });

  it("accepts an option id and rejects the option's text", () => {
    expect(validateCustomFieldValues({ d1: "opt1" }, [dropdown]).valid).toBe(true);
    expect(validateCustomFieldValues({ d1: "Apples" }, [dropdown]).valid).toBe(false);
  });

  it("accepts a list of known ids for a multiselect and rejects an unknown one", () => {
    const multi = field({
      _id: "m1",
      fieldType: "multiselect",
      options: [
        { id: "a", value: "A", color: "#000", order: 0 },
        { id: "b", value: "B", color: "#000", order: 1 },
      ],
    });
    expect(validateCustomFieldValues({ m1: ["a", "b"] }, [multi]).valid).toBe(true);
    expect(validateCustomFieldValues({ m1: ["a", "zz"] }, [multi]).valid).toBe(false);
    expect(validateCustomFieldValues({ m1: "a" }, [multi]).valid).toBe(false);
  });

  it("still enforces required on a live field", () => {
    const required = field({ _id: "r1", fieldType: "text", required: true });
    expect(validateCustomFieldValues({}, [required]).valid).toBe(false);
    expect(validateCustomFieldValues({ r1: [] }, [required]).valid).toBe(false);
  });

  it("lets archiving override required", () => {
    const archivedRequired = field({
      _id: "r1",
      fieldType: "text",
      required: true,
      archived: true,
    });
    expect(validateCustomFieldValues({}, [archivedRequired]).valid).toBe(true);
  });

  it("stops policing the value of an archived field", () => {
    const archived = field({ _id: "d1", archived: true, options: [] });
    expect(validateCustomFieldValues({ d1: "gone-option" }, [archived]).valid).toBe(true);
  });

  it("still refuses a value for a field that does not exist", () => {
    expect(validateCustomFieldValues({ nope: "x" }, [dropdown]).valid).toBe(false);
  });
});

describe("sanitizeCustomFieldValues", () => {
  it("keeps the values of an archived field", () => {
    const archived = field({ _id: "a1", archived: true });
    expect(sanitizeCustomFieldValues({ a1: "kept" }, [archived])).toEqual({ a1: "kept" });
  });

  it("drops values whose field is gone entirely", () => {
    expect(sanitizeCustomFieldValues({ a1: "x", gone: "y" }, [field({ _id: "a1" })])).toEqual({
      a1: "x",
    });
  });
});

describe("matchesFieldFilter", () => {
  const number = { fieldType: "number" as const };
  const date = { fieldType: "date" as const };
  const text = { fieldType: "text" as const };
  const check = { fieldType: "checkbox" as const };
  const multi = { fieldType: "multiselect" as const };

  it("treats a range as inclusive and open-ended at either end", () => {
    expect(matchesFieldFilter(5, { from: "3", to: "8" }, number)).toBe(true);
    expect(matchesFieldFilter(3, { from: "3", to: "8" }, number)).toBe(true);
    expect(matchesFieldFilter(8, { from: "3", to: "8" }, number)).toBe(true);
    expect(matchesFieldFilter(2, { from: "3" }, number)).toBe(false);
    expect(matchesFieldFilter(99, { from: "3" }, number)).toBe(true);
    expect(matchesFieldFilter(2, { to: "3" }, number)).toBe(true);
  });

  it("excludes an empty value from any range", () => {
    expect(matchesFieldFilter(undefined, { from: "3" }, number)).toBe(false);
    expect(matchesFieldFilter("", { to: "9" }, number)).toBe(false);
  });

  it("lets everything through when the range is unset", () => {
    expect(matchesFieldFilter(undefined, {}, number)).toBe(true);
  });

  it("compares dates chronologically", () => {
    expect(matchesFieldFilter("2026-05-01", { from: "2026-01-01", to: "2026-12-31" }, date)).toBe(true);
    expect(matchesFieldFilter("2025-05-01", { from: "2026-01-01" }, date)).toBe(false);
  });

  it("matches text by case-insensitive substring", () => {
    expect(matchesFieldFilter("Hello World", { value: "wor" }, text)).toBe(true);
    expect(matchesFieldFilter("Hello", { value: "zzz" }, text)).toBe(false);
  });

  it("matches a checkbox on both true and false", () => {
    expect(matchesFieldFilter(true, { value: "true" }, check)).toBe(true);
    expect(matchesFieldFilter(false, { value: "false" }, check)).toBe(true);
    expect(matchesFieldFilter(true, { value: "false" }, check)).toBe(false);
  });

  it("matches a multiselect when the option is among the picked ones", () => {
    expect(matchesFieldFilter(["a", "b"], { value: "b" }, multi)).toBe(true);
    expect(matchesFieldFilter(["a"], { value: "b" }, multi)).toBe(false);
    expect(matchesFieldFilter(undefined, { value: "b" }, multi)).toBe(false);
  });
});

describe("matchesAllFieldFilters", () => {
  const definitions = [
    { _id: "f1", fieldType: "number" as const },
    { _id: "f2", fieldType: "text" as const },
  ];

  it("requires every filter to pass", () => {
    const values = { f1: 5, f2: "hello" };
    expect(matchesAllFieldFilters(values, { f1: { from: "3" }, f2: { value: "hell" } }, definitions)).toBe(true);
    expect(matchesAllFieldFilters(values, { f1: { from: "9" }, f2: { value: "hell" } }, definitions)).toBe(false);
  });

  it("ignores a filter whose field is gone rather than hiding everything", () => {
    expect(matchesAllFieldFilters({ f1: 5 }, { ghost: { value: "x" } }, definitions)).toBe(true);
  });
});

describe("resolveFieldsByName", () => {
  const definitions = [
    {
      _id: "f1",
      name: "Owoce",
      fieldType: "dropdown" as const,
      options: [{ id: "opt-a", value: "Apples", color: "#000", order: 0 }],
    },
    { _id: "f2", name: "Points", fieldType: "number" as const, options: [] },
    { _id: "f3", name: "Done", fieldType: "checkbox" as const, options: [] },
    {
      _id: "f4",
      name: "Tags",
      fieldType: "multiselect" as const,
      options: [
        { id: "t1", value: "one", color: "#000", order: 0 },
        { id: "t2", value: "two", color: "#000", order: 1 },
      ],
    },
    { _id: "f5", name: "Gone", fieldType: "text" as const, options: [], archived: true },
  ];

  it("resolves a field name and an option name to their ids", () => {
    expect(resolveFieldsByName({ Owoce: "Apples" }, definitions)).toEqual({ f1: "opt-a" });
  });

  it("matches case-insensitively on both the field and the option", () => {
    expect(resolveFieldsByName({ owoce: "apples" }, definitions)).toEqual({ f1: "opt-a" });
  });

  it("accepts an option id as well as its name", () => {
    expect(resolveFieldsByName({ Owoce: "opt-a" }, definitions)).toEqual({ f1: "opt-a" });
  });

  it("takes a list for a multiselect, and a bare value as a list of one", () => {
    expect(resolveFieldsByName({ Tags: ["one", "two"] }, definitions)).toEqual({ f4: ["t1", "t2"] });
    expect(resolveFieldsByName({ Tags: "two" }, definitions)).toEqual({ f4: ["t2"] });
  });

  it("coerces numbers and checkboxes", () => {
    expect(resolveFieldsByName({ Points: "8" }, definitions)).toEqual({ f2: 8 });
    expect(resolveFieldsByName({ Done: "true" }, definitions)).toEqual({ f3: true });
  });

  it("throws on an unknown field, and lists what is available", () => {
    expect(() => resolveFieldsByName({ Nope: "x" }, definitions)).toThrow(/Unknown field "Nope"/);
    expect(() => resolveFieldsByName({ Nope: "x" }, definitions)).toThrow(/Owoce/);
  });

  it("throws on a value that is not one of the field's options", () => {
    expect(() => resolveFieldsByName({ Owoce: "Bananas" }, definitions)).toThrow(/not an option/);
  });

  it("throws on a number that is not a number", () => {
    expect(() => resolveFieldsByName({ Points: "eight" }, definitions)).toThrow(/must be a number/);
  });

  it("refuses to write to an archived field", () => {
    expect(() => resolveFieldsByName({ Gone: "x" }, definitions)).toThrow(/Unknown field/);
  });
});

describe("parseOptions ids", () => {
  it("mints an id for an option that arrives without one", () => {
    const result = parseOptions([{ id: "", value: "Apples", color: "#ef4444", order: 0 }]);
    expect(result.error).toBeUndefined();
    expect(result.options?.[0].id).toBeTruthy();
    expect(result.options?.[0].id).not.toBe("");
  });

  it("accepts two new options in one save", () => {
    const result = parseOptions([
      { id: "", value: "Apples", color: "#ef4444", order: 0 },
      { id: "", value: "Pears", color: "#22c55e", order: 1 },
    ]);
    expect(result.error).toBeUndefined();
    expect(new Set(result.options?.map((o) => o.id)).size).toBe(2);
  });

  it("keeps the id of an option that already exists, so tasks survive a rename", () => {
    const existing = [{ id: "ui-a1b2", value: "ui", color: "#3b82f6", order: 0 }];
    const result = parseOptions([{ id: "ui-a1b2", value: "Interface", color: "#3b82f6", order: 0 }], existing);
    expect(result.options?.[0].id).toBe("ui-a1b2");
  });
});

describe("matchOptionValue", () => {
  const field = {
    options: [
      { id: "opt-s", value: "S", color: "#000", order: 0 },
      { id: "opt-xl", value: "XL", color: "#000", order: 1 },
    ],
  };

  it("matches an option by its value, case and spacing insensitively", () => {
    expect(matchOptionValue(field, "xl")).toBe("opt-xl");
    expect(matchOptionValue(field, "  S  ")).toBe("opt-s");
  });

  it("accepts an option id, so a resolved value round-trips", () => {
    expect(matchOptionValue(field, "opt-s")).toBe("opt-s");
  });

  it("returns undefined for a value the project does not offer", () => {
    expect(matchOptionValue(field, "XXL")).toBeUndefined();
  });

  it("returns undefined rather than throwing for a missing field or empty value", () => {
    expect(matchOptionValue(undefined, "S")).toBeUndefined();
    expect(matchOptionValue(field, "")).toBeUndefined();
    expect(matchOptionValue(field, null)).toBeUndefined();
  });
});

describe("customFieldActivityChanges", () => {
  const difficulty = field({
    _id: "f-diff",
    name: "Difficulty",
    fieldType: "dropdown",
    options: [
      { id: "opt-m", value: "M", color: "#000", order: 0 },
      { id: "opt-l", value: "L", color: "#000", order: 1 },
    ],
  });
  const platforms = field({
    _id: "f-plat",
    name: "Platforms",
    fieldType: "multiselect",
    options: [
      { id: "p2-ios", value: "iOS", color: "#000", order: 0 },
      { id: "p1-web", value: "Web", color: "#000", order: 1 },
    ],
  });
  const notes = field({ _id: "f-notes", name: "Notes", fieldType: "text" });
  const spike = field({ _id: "f-spike", name: "Spike?", fieldType: "checkbox" });
  const points = field({ _id: "f-pts", name: "Points", fieldType: "number" });
  const target = field({ _id: "f-date", name: "Target", fieldType: "date" });

  it("reports the option's text, not its id", () => {
    expect(
      customFieldActivityChanges({ "f-diff": "opt-m" }, { "f-diff": "opt-l" }, [difficulty])
    ).toEqual([{ name: "Difficulty", before: "M", after: "L" }]);
  });

  it("names the field, so a later rename cannot rewrite what history says", () => {
    const [change] = customFieldActivityChanges({}, { "f-notes": "ping" }, [notes]);
    expect(change.name).toBe("Notes");
    expect(change.before).toBe("");
    expect(change.after).toBe("ping");
  });

  it("reports a cleared field as a change to empty, not as no change", () => {
    expect(customFieldActivityChanges({ "f-diff": "opt-m" }, {}, [difficulty])).toEqual([
      { name: "Difficulty", before: "M", after: "" },
    ]);
  });

  it("says nothing about a field whose value did not move", () => {
    expect(
      customFieldActivityChanges(
        { "f-diff": "opt-m", "f-notes": "same" },
        { "f-diff": "opt-l", "f-notes": "same" },
        [difficulty, notes]
      )
    ).toEqual([{ name: "Difficulty", before: "M", after: "L" }]);
  });

  it("reports one entry per field when several move at once", () => {
    expect(
      customFieldActivityChanges(
        { "f-diff": "opt-m" },
        { "f-diff": "opt-l", "f-notes": "new" },
        [difficulty, platforms, notes]
      )
    ).toEqual([
      { name: "Difficulty", before: "M", after: "L" },
      { name: "Notes", before: "", after: "new" },
    ]);
  });

  it("lists every selection of a multiselect", () => {
    expect(
      customFieldActivityChanges(
        { "f-plat": ["p2-ios"] },
        { "f-plat": ["p2-ios", "p1-web"] },
        [platforms]
      )
    ).toEqual([{ name: "Platforms", before: "iOS", after: "iOS, Web" }]);
  });

  it("reads the Map a hydrated document carries, not only a plain object", () => {
    expect(
      customFieldActivityChanges(
        { "f-diff": "opt-m" },
        new Map([["f-diff", "opt-l"]]),
        [difficulty]
      )
    ).toEqual([{ name: "Difficulty", before: "M", after: "L" }]);
  });

  it("says nothing when a multiselect is reordered but still holds the same options", () => {
    expect(
      customFieldActivityChanges(
        { "f-plat": ["p2-ios", "p1-web"] },
        { "f-plat": ["p1-web", "p2-ios"] },
        [platforms]
      )
    ).toEqual([]);
  });

  it("reports a reordered multiselect that also gained an option, in the project's order", () => {
    expect(
      customFieldActivityChanges({ "f-plat": ["p1-web"] }, { "f-plat": ["p1-web", "p2-ios"] }, [
        platforms,
      ])
    ).toEqual([{ name: "Platforms", before: "Web", after: "iOS, Web" }]);
  });

  it("says nothing when a checkbox goes from never-set to explicitly false", () => {
    expect(customFieldActivityChanges({}, { "f-spike": false }, [spike])).toEqual([]);
  });

  it("reports a ticked checkbox in the words the task shows", () => {
    expect(customFieldActivityChanges({}, { "f-spike": true }, [spike])).toEqual([
      { name: "Spike?", before: "No", after: "Yes" },
    ]);
    expect(customFieldActivityChanges({ "f-spike": true }, { "f-spike": false }, [spike])).toEqual([
      { name: "Spike?", before: "Yes", after: "No" },
    ]);
  });

  it("reports a number, including a change to zero", () => {
    expect(customFieldActivityChanges({ "f-pts": 3 }, { "f-pts": 0 }, [points])).toEqual([
      { name: "Points", before: "3", after: "0" },
    ]);
  });

  it("reports a date", () => {
    expect(
      customFieldActivityChanges({}, { "f-date": "2026-08-08" }, [target])
    ).toEqual([{ name: "Target", before: "", after: "2026-08-08" }]);
  });

  it("ignores a value whose field the project no longer defines", () => {
    expect(customFieldActivityChanges({ "f-gone": "x" }, {}, [difficulty])).toEqual([]);
  });

  it("returns nothing when the project defines no fields", () => {
    expect(customFieldActivityChanges({ "f-diff": "opt-m" }, {}, [])).toEqual([]);
  });
});
