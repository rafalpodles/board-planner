import { describe, expect, it } from "vitest";
import {
  applyEdits,
  carriesMarker,
  classify,
  escapeRegExp,
  insideRepo,
  marked,
  parseManifest,
  renderTable,
  restoreAll,
  summarise,
  untrusted,
  type JournalEntry,
  type Outcome,
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
      read: (file: string) => {
        if (!(file in files)) throw new Error(`ENOENT: ${file}`);
        return files[file];
      },
      write: (file: string, content: string) => {
        writes.push(file);
        files[file] = content;
      },
    };
  };
  const byDriver = (content: string) => marked(content, "mutation-check:a:1");

  it("writes back every original the driver left mutated, and only those", () => {
    const fs = memory({ "a.ts": byDriver("mutated"), "b.ts": "same" });
    const journal: JournalEntry[] = [
      { file: "a.ts", original: "original" },
      { file: "b.ts", original: "same" },
    ];
    expect(restoreAll(journal, fs)).toEqual({ restored: ["a.ts"], leftAlone: [] });
    expect(fs.files).toEqual({ "a.ts": "original", "b.ts": "same" });
    expect(fs.writes).toEqual(["a.ts"]);
  });

  it("leaves a file alone once it no longer carries the marker — someone edited it since", () => {
    const fs = memory({ "a.ts": "my own edit after switching branch" });
    expect(restoreAll([{ file: "a.ts", original: "stale original" }], fs)).toEqual({
      restored: [],
      leftAlone: ["a.ts"],
    });
    expect(fs.files["a.ts"]).toBe("my own edit after switching branch");
    expect(fs.writes).toEqual([]);
  });

  it("leaves a file alone that no longer exists, and creates nothing", () => {
    const fs = memory({});
    expect(restoreAll([{ file: "gone.ts", original: "x" }], fs)).toEqual({ restored: [], leftAlone: ["gone.ts"] });
    expect(fs.writes).toEqual([]);
  });

  it("does not take a marker anywhere but the first line for the driver's", () => {
    const fs = memory({ "a.ts": `const x = 1;\n${byDriver("y")}` });
    expect(restoreAll([{ file: "a.ts", original: "o" }], fs).leftAlone).toEqual(["a.ts"]);
  });

  it("ends on the oldest original when one file was journalled twice", () => {
    const fs = memory({ "a.ts": byDriver("second mutation") });
    restoreAll(
      [
        { file: "a.ts", original: "pristine" },
        { file: "a.ts", original: byDriver("first mutation") },
      ],
      fs
    );
    expect(fs.files["a.ts"]).toBe("pristine");
  });

  it("does nothing with an empty journal", () => {
    const fs = memory({ "a.ts": "x" });
    expect(restoreAll([], fs)).toEqual({ restored: [], leftAlone: [] });
    expect(fs.writes).toEqual([]);
  });
});

describe("carriesMarker", () => {
  it("recognises what marked() writes, and nothing else", () => {
    expect(carriesMarker(marked("x", "mutation-check:id:abc"))).toBe(true);
    expect(carriesMarker("// mutation check\nx")).toBe(false);
    expect(carriesMarker("x")).toBe(false);
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

describe("untrusted", () => {
  const [plain, control] = parseManifest(manifest(entry(), entry({ id: "the-control", control: true })));
  const result = (mutation: typeof plain, outcome: Outcome) => ({ mutation, outcome, detail: "" });

  it("flags a mutated run that ran nothing — no report, or a timeout — after a green baseline", () => {
    expect(untrusted([result(plain, "no-tests")]).map((r) => r.outcome)).toEqual(["no-tests"]);
  });

  it("flags a mutation the dev server never compiled, and a control that was not caught", () => {
    expect(untrusted([result(plain, "not-picked-up"), result(control, "survived")])).toHaveLength(2);
  });

  it("trusts caught, survived and a red baseline, which is reported but measured nothing", () => {
    expect(
      untrusted([result(plain, "caught"), result(plain, "survived"), result(plain, "baseline-red"), result(control, "caught")])
    ).toEqual([]);
  });
});
