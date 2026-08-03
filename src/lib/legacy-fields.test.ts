import { describe, it, expect } from "vitest";
import {
  legacyFieldSeeds,
  findLegacyField,
  migratedValuesFor,
  withValuesInUse,
} from "./legacy-fields";
import { ApiCustomField, ApiLabel } from "@/types";

const project = {
  components: ["ui", "backend"],
  labels: [
    { _id: "lab1", name: "urgent", color: "#ff0000" },
    { _id: "lab2", name: "chore", color: "#00ff00" },
  ] as ApiLabel[],
};

function seededFields(): ApiCustomField[] {
  return legacyFieldSeeds(project).map((f, i) => ({ ...f, _id: `f${i}` })) as ApiCustomField[];
}

describe("legacyFieldSeeds", () => {
  it("reproduces the three fields in form order", () => {
    expect(legacyFieldSeeds(project).map((f) => f.name)).toEqual([
      "Component",
      "Difficulty",
      "Labels",
    ]);
  });

  // Alphabetically this would be L, M, S, XL — which would silently change what
  // sorting by difficulty means
  it("orders difficulty S, M, L, XL rather than alphabetically", () => {
    const difficulty = legacyFieldSeeds(project)[1];
    expect(difficulty.options.map((o) => o.value)).toEqual(["S", "M", "L", "XL"]);
    expect(difficulty.options.map((o) => o.order)).toEqual([0, 1, 2, 3]);
  });

  // This is what lets task.labels carry across with no data rewrite at all
  it("reuses each label's own id as the option id, and keeps its colour", () => {
    const labels = legacyFieldSeeds(project)[2];
    expect(labels.fieldType).toBe("multiselect");
    expect(labels.options.map((o) => o.id)).toEqual(["lab1", "lab2"]);
    expect(labels.options[0].color).toBe("#ff0000");
  });

  it("matches how the three behave today: on the card, and filterable", () => {
    const [component, difficulty, labels] = legacyFieldSeeds(project);
    expect([component.showOnCard, difficulty.showOnCard, labels.showOnCard]).toEqual([
      true,
      true,
      true,
    ]);
    expect([component.showInList, difficulty.showInList]).toEqual([true, true]);
    expect(labels.filterable).toBe(true);
  });

  it("copes with a project that has neither components nor labels", () => {
    const seeds = legacyFieldSeeds({});
    expect(seeds[0].options).toEqual([]);
    expect(seeds[2].options).toEqual([]);
  });
});

describe("migratedValuesFor", () => {
  const fields = seededFields();

  it("maps each legacy column onto its seeded field id", () => {
    const values = migratedValuesFor(
      { component: "ui", difficulty: "S", labels: ["lab1", "lab2"] },
      fields
    );
    expect(values).toEqual({ f0: "ui", f1: "S", f2: ["lab1", "lab2"] });
  });

  it("writes nothing for a value the task does not have", () => {
    expect(migratedValuesFor({ difficulty: "M" }, fields)).toEqual({ f1: "M" });
  });
});

describe("withValuesInUse", () => {
  // A task can hold a component that was deleted from the project's list; seeding
  // only the current list would clear that task's value on its next save
  it("adds an option for a value still in use but missing from the list", () => {
    const [component] = legacyFieldSeeds(project);
    const widened = withValuesInUse(component, ["ui", "legacy-thing"]);
    expect(widened.options.map((o) => o.id)).toEqual(["ui", "backend", "legacy-thing"]);
  });

  it("adds nothing when every value is already an option", () => {
    const [component] = legacyFieldSeeds(project);
    expect(withValuesInUse(component, ["ui", "backend"]).options).toHaveLength(2);
  });

  it("ignores blanks", () => {
    const [component] = legacyFieldSeeds(project);
    expect(withValuesInUse(component, ["", "ui"]).options).toHaveLength(2);
  });
});

describe("findLegacyField", () => {
  it("matches by name regardless of case, so a rename to lowercase still resolves", () => {
    const fields = [{ _id: "x", name: "difficulty" }] as ApiCustomField[];
    expect(findLegacyField(fields, "difficulty")?._id).toBe("x");
  });

  it("returns nothing when the project has no such field", () => {
    expect(findLegacyField([], "component")).toBeUndefined();
  });
});
