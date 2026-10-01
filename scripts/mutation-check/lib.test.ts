import { describe, expect, it } from "vitest";
import {
  applyEdits,
  classify,
  escapeRegExp,
  insideRepo,
  marked,
  parseManifest,
  renderTable,
  restoreAll,
  summarise,
  type JournalEntry,
} from "./lib";

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "board-delete",
  file: "src/hooks/use-project-board.ts",
  edits: [{ find: "a", replace: "b" }],
  spec: "e2e/board-irreversible.spec.ts",
  grep: "Delete removes it",
  probe: "/projects/TP",
  assertion: "card(page, 3).toHaveCount(0)",
  ...overrides,
});
const manifest = (...mutations: unknown[]) => JSON.stringify({ mutations });

describe("parseManifest", () => {
  it("reads a well-formed entry, control defaulting to false", () => {
    const [m] = parseManifest(manifest(entry()));
    expect(m).toMatchObject({ id: "board-delete", control: false, edits: [{ find: "a", replace: "b" }] });
    expect(parseManifest(manifest(entry({ control: true })))[0].control).toBe(true);
  });

  it("refuses an empty manifest", () => {
    expect(() => parseManifest(manifest())).toThrow(/non-empty "mutations"/);
  });

  it("refuses an id used twice", () => {
    expect(() => parseManifest(manifest(entry(), entry()))).toThrow(/used twice/);
  });

  it.each([
    ["a file outside the repository", { file: "../ClaudePlanner/src/lib/auth.ts" }, /outside the repository/],
    ["an absolute file", { file: "/etc/hosts.ts" }, /outside the repository/],
    ["a file that cannot carry a comment", { file: "src/data.json" }, /pick-up marker/],
    ["a spec outside e2e", { spec: "src/lib/auth.test.ts" }, /e2e\/\*\.spec\.ts/],
    ["a probe that is not a path", { probe: "projects/TP" }, /starting with \//],
    ["no edits", { edits: [] }, /non-empty array/],
    ["an edit that changes nothing", { edits: [{ find: "x", replace: "x" }] }, /equals "find"/],
    ["a missing grep", { grep: "" }, /"grep" must be a non-empty string/],
    ["an id with spaces", { id: "Board delete" }, /lowercase/],
  ])("refuses %s", (_, overrides, message) => {
    expect(() => parseManifest(manifest(entry(overrides)))).toThrow(message);
  });

  it("accepts an empty replacement, which is how a line is deleted", () => {
    expect(parseManifest(manifest(entry({ edits: [{ find: "x();", replace: "" }] })))[0].edits[0].replace).toBe("");
  });
});

describe("insideRepo", () => {
  it("allows a nested relative path and refuses one that climbs out", () => {
    expect(insideRepo("src/a/../b.ts")).toBe(true);
    expect(insideRepo("src/../../b.ts")).toBe(false);
    expect(insideRepo("..")).toBe(false);
  });
});

describe("applyEdits", () => {
  it("applies each edit to the result of the one before", () => {
    expect(applyEdits("one two", [{ find: "one", replace: "three" }, { find: "three two", replace: "done" }])).toBe("done");
  });

  it("refuses an edit that matches nothing, or more than once", () => {
    expect(() => applyEdits("abc", [{ find: "x", replace: "y" }])).toThrow(/matched 0 times/);
    expect(() => applyEdits("a a", [{ find: "a", replace: "b" }])).toThrow(/matched 2 times/);
  });

  it("inserts a replacement literally, $ and all", () => {
    expect(applyEdits("x", [{ find: "x", replace: "$&$1" }])).toBe("$&$1");
  });
});

describe("marked", () => {
  it("puts the marker on a line of its own above the source, leaving the source intact", () => {
    expect(marked('"use client";\nx', "mutation-check:a:1")).toBe('// mutation-check:a:1\n"use client";\nx');
  });
});

describe("escapeRegExp", () => {
  it("makes a test title match itself literally", () => {
    const title = "a (double) click? sends one DELETE, not two [x] + $";
    expect(new RegExp(escapeRegExp(title)).test(title)).toBe(true);
    expect(new RegExp(escapeRegExp("a.b")).test("axb")).toBe(false);
  });
});

describe("restoreAll", () => {
  const memory = (files: Record<string, string>) => {
    const writes: string[] = [];
    return {
      files,
      writes,
      read: (file: string) => files[file],
      write: (file: string, content: string) => {
        writes.push(file);
        files[file] = content;
      },
    };
  };

  it("writes back every original that differs, and only those", () => {
    const fs = memory({ "a.ts": "mutated", "b.ts": "same" });
    const journal: JournalEntry[] = [
      { file: "a.ts", original: "original" },
      { file: "b.ts", original: "same" },
    ];
    expect(restoreAll(journal, fs)).toEqual(["a.ts"]);
    expect(fs.files).toEqual({ "a.ts": "original", "b.ts": "same" });
    expect(fs.writes).toEqual(["a.ts"]);
  });

  it("ends on the oldest original when one file was journalled twice", () => {
    const fs = memory({ "a.ts": "second mutation" });
    restoreAll(
      [
        { file: "a.ts", original: "pristine" },
        { file: "a.ts", original: "first mutation" },
      ],
      fs
    );
    expect(fs.files["a.ts"]).toBe("pristine");
  });

  it("does nothing with an empty journal", () => {
    const fs = memory({ "a.ts": "x" });
    expect(restoreAll([], fs)).toEqual([]);
    expect(fs.writes).toEqual([]);
  });
});

describe("summarise and classify", () => {
  const result = (status: string, message?: string, line?: number) => ({
    status,
    ...(message ? { error: { message, ...(line ? { location: { file: "/repo/e2e/x.spec.ts", line } } : {}) } } : {}),
  });
  const report = (...statuses: ReturnType<typeof result>[][]) => ({
    suites: [{ suites: [{ specs: statuses.map((results) => ({ tests: [{ results }] })) }] }],
  });

  it("counts a test by its last result and keeps the first failure's first line, without colour", () => {
    const summary = summarise(
      report([result("passed")], [result("failed", "\u001b[31mError: expect(locator).toHaveCount(0)\u001b[39m\nmore", 302)], [result("skipped")])
    );
    expect(summary).toEqual({ passed: 1, failed: 1, skipped: 1, firstError: "Error: expect(locator).toHaveCount(0) (x.spec.ts:302)" });
    expect(classify(summary)).toBe("caught");
  });

  it("treats a timed-out test as a failure", () => {
    expect(classify(summarise(report([result("timedOut", "Test timeout of 180000ms exceeded.")])))).toBe("caught");
  });

  it("calls an all-green run survived", () => {
    expect(classify(summarise(report([result("passed")])))).toBe("survived");
  });

  it("calls a run that ran nothing no-tests, not survived", () => {
    expect(classify(summarise({ suites: [] }))).toBe("no-tests");
    expect(classify(summarise(report([result("skipped")])))).toBe("no-tests");
  });

  it("falls back to a top-level error, such as a spec that would not load", () => {
    expect(summarise({ suites: [], errors: [{ message: "SyntaxError: boom" }] }).firstError).toBe("SyntaxError: boom");
  });
});

describe("renderTable", () => {
  it("renders one row per result, escaping pipes and marking the control", () => {
    const [m] = parseManifest(manifest(entry({ control: true, assertion: "a | b" })));
    const table = renderTable([{ mutation: m, outcome: "caught", detail: "x\ny" }]);
    expect(table.split("\n")).toEqual([
      "| id | spec | assertion | result | detail |",
      "| --- | --- | --- | --- | --- |",
      "| board-delete (control) | board-irreversible.spec.ts | a \\| b | **caught** | x y |",
    ]);
  });
});
