import { describe, it, expect } from "vitest";
import {
  normalizeOptions,
  normalizeFields,
  sortedFields,
  activeFields,
  orderedOptions,
  validateCustomFieldValues,
  sanitizeCustomFieldValues,
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
  // The whole migration rests on this: values already stored on tasks are the
  // option strings, so the id has to stay that string or every value detaches
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

  // Otherwise archiving a required field would block every save on every task
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
  // The point of archiving: deleting a definition used to wipe the value from
  // every task on its next save
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
