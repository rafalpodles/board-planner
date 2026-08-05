import { describe, it, expect } from "vitest";
import { ApiCustomField } from "@/types";
import { choiceFieldsForPrompt, resolveGeneratedFields } from "./ai-fields";

function field(over: Partial<ApiCustomField> & { _id: string; name: string }): ApiCustomField {
  return {
    fieldType: "dropdown",
    options: [],
    required: false,
    order: 0,
    showOnCard: false,
    showInList: false,
    filterable: false,
    archived: false,
    ...over,
  } as ApiCustomField;
}

const size = field({
  _id: "f-size",
  name: "Size",
  options: [
    { id: "s", value: "S", color: "#000", order: 0 },
    { id: "l", value: "L", color: "#000", order: 1 },
  ],
});
const area = field({
  _id: "f-area",
  name: "Area",
  options: [{ id: "be", value: "backend", color: "#000", order: 0 }],
});

describe("choiceFieldsForPrompt", () => {
  // A project that defines no choice fields must not be asked about any. The prompt
  // used to fall back to a hardcoded S/M/L/XL scale, so every generation spent tokens
  // on a field the project did not have and could not store.
  it("is empty for a project with no choice fields", () => {
    expect(choiceFieldsForPrompt([])).toEqual([]);
    expect(choiceFieldsForPrompt([field({ _id: "t", name: "Notes", fieldType: "text" })])).toEqual(
      []
    );
  });

  it("offers each choice field by its own name and options", () => {
    expect(choiceFieldsForPrompt([size, area])).toEqual([
      { name: "Size", options: ["S", "L"] },
      { name: "Area", options: ["backend"] },
    ]);
  });

  it("skips an archived field and one with no options", () => {
    const gone = field({ _id: "g", name: "Gone", archived: true, options: size.options });
    const bare = field({ _id: "b", name: "Bare" });
    expect(choiceFieldsForPrompt([size, gone, bare]).map((f) => f.name)).toEqual(["Size"]);
  });

  it("includes multi-choice fields, which are still a closed list", () => {
    const platforms = field({
      _id: "p",
      name: "Platforms",
      fieldType: "multiselect",
      options: [{ id: "ios", value: "iOS", color: "#000", order: 0 }],
    });
    expect(choiceFieldsForPrompt([platforms]).map((f) => f.name)).toEqual(["Platforms"]);
  });
});

describe("resolveGeneratedFields", () => {
  it("maps the model's answers onto field ids and option ids", () => {
    expect(resolveGeneratedFields({ Size: "L", Area: "backend" }, [size, area])).toEqual({
      "f-size": "l",
      "f-area": "be",
    });
  });

  it("matches a field name regardless of case and surrounding space", () => {
    expect(resolveGeneratedFields({ "  size  ": "s" }, [size])).toEqual({ "f-size": "s" });
  });

  // The model's answer is a suggestion. Anything that misses is dropped, never thrown.
  it("drops a field the project does not have", () => {
    expect(resolveGeneratedFields({ Nonsense: "x" }, [size])).toEqual({});
  });

  it("drops an option the field does not offer, keeping the rest", () => {
    expect(resolveGeneratedFields({ Size: "XXL", Area: "backend" }, [size, area])).toEqual({
      "f-area": "be",
    });
  });

  it("survives a malformed answer", () => {
    expect(resolveGeneratedFields(undefined, [size])).toEqual({});
    expect(resolveGeneratedFields({ Size: null }, [size])).toEqual({});
    expect(resolveGeneratedFields("not an object", [size])).toEqual({});
  });

  // A multiselect stores an array; a bare string there fails validation on save, so the
  // task the user just generated would refuse to save with no clue why
  it("wraps a multi-choice answer in an array", () => {
    const platforms = field({
      _id: "f-plat",
      name: "Platforms",
      fieldType: "multiselect",
      options: [
        { id: "ios", value: "iOS", color: "#000", order: 0 },
        { id: "and", value: "Android", color: "#000", order: 1 },
      ],
    });

    expect(resolveGeneratedFields({ Platforms: "iOS" }, [platforms])).toEqual({
      "f-plat": ["ios"],
    });
    expect(resolveGeneratedFields({ Platforms: ["iOS", "Android"] }, [platforms])).toEqual({
      "f-plat": ["ios", "and"],
    });
    expect(resolveGeneratedFields({ Platforms: ["iOS", "Symbian"] }, [platforms])).toEqual({
      "f-plat": ["ios"],
    });
    expect(resolveGeneratedFields({ Platforms: ["Symbian"] }, [platforms])).toEqual({});
  });

  it("keeps a single-choice answer a plain value, not an array", () => {
    expect(resolveGeneratedFields({ Size: "L" }, [size])).toEqual({ "f-size": "l" });
  });

  it("never writes to an archived field", () => {
    const gone = field({ _id: "g", name: "Gone", archived: true, options: size.options });
    expect(resolveGeneratedFields({ Gone: "S" }, [gone])).toEqual({});
  });
});
