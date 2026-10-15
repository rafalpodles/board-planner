import { describe, it, expect } from "vitest";
import { csvToBundle, decodeCsv, detectDelimiter, guessTargets, normaliseDay, parseCsv, readCsvTable } from "./csv";
import { parseBundle } from "./bundle";

const FIELDS = [
  { name: "Size", fieldType: "dropdown" },
  { name: "Points", fieldType: "number" },
  { name: "Urgent", fieldType: "checkbox" },
  { name: "Tags", fieldType: "multiselect" },
];

describe("decodeCsv", () => {
  it("reads UTF-8 and drops its byte-order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Tytuł;Zażółć")]);
    expect(decodeCsv(bytes)).toBe("Tytuł;Zażółć");
  });

  it("falls back to windows-1250 for a file Polish Excel saved", () => {
    // "Zażółć" in windows-1250
    const bytes = new Uint8Array([0x5a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6]);
    expect(decodeCsv(bytes)).toBe("Zażółć");
  });
});

describe("parseCsv", () => {
  it("picks the delimiter the header uses, ignoring the ones inside quotes", () => {
    expect(detectDelimiter('Title;Status;"a,b,c"\nx;y;z')).toBe(";");
    expect(detectDelimiter("Title,Status\nx;y,z")).toBe(",");
    expect(detectDelimiter("Title\tStatus\n")).toBe("\t");
  });

  it("keeps quoted delimiters, doubled quotes and line breaks inside a cell", () => {
    const text = 'Title;Description\r\n"One; two";"Line 1\r\nLine ""2"""\r\nPlain;\r\n';
    expect(parseCsv(text)).toEqual([
      ["Title", "Description"],
      ["One; two", 'Line 1\r\nLine "2"'],
      ["Plain", ""],
    ]);
  });

  it("skips blank lines and reads a last line with no line break", () => {
    expect(parseCsv("a,b\n\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("stores a formula as the text it is, never its value", () => {
    const table = readCsvTable('Title\n"=HYPERLINK(""http://evil"",""x"")"\n+1+1');
    const bundle = csvToBundle(table, ["title"], "CSV", []);
    expect(bundle.tasks.map((t) => t.title)).toEqual(['=HYPERLINK("http://evil","x")', "+1+1"]);
  });
});

describe("guessTargets", () => {
  it("guesses from common English and Polish headers and from the board's field names, once each", () => {
    expect(guessTargets(["Issue key", "Summary", "Status", "Assignee", "Size", "Termin", "Title", "Whatever"], FIELDS)).toEqual([
      "id",
      "title",
      "status",
      "assignee",
      "field:Size",
      "dueDate",
      "ignore",
      "ignore",
    ]);
  });
});

describe("normaliseDay", () => {
  it.each([
    ["2026-10-15", "2026-10-15"],
    ["2026-10-15T08:00:00Z", "2026-10-15"],
    ["15.10.2026", "2026-10-15"],
    ["5.1.2026", "2026-01-05"],
    ["25/12/2026", "2026-12-25"],
    ["12/25/2026", "2026-12-25"],
    ["03/04/2026", "03/04/2026"],
    ["31.02.2026", "31.02.2026"],
    ["next week", "next week"],
  ])("%s becomes %s", (raw, day) => expect(normaliseDay(raw)).toBe(day));
});

describe("csvToBundle", () => {
  const table = readCsvTable(
    [
      "Key;Summary;Status;Assignee;Due;Size;Points;Urgent;Tags;Internal",
      "A-1;First;Open;maya;15.10.2026;Large;2,5;tak;red, blue;kept out",
      "A-2;;Done;;;;;;;",
    ].join("\n")
  );
  const targets = guessTargets(table.headers, FIELDS);

  it("turns each row into a task the engine accepts, keyed by the id column", () => {
    const bundle = csvToBundle(table, targets, "CSV", FIELDS);
    expect(parseBundle(bundle).ok).toBe(true);
    expect(bundle).toEqual({
      source: "CSV",
      tasks: [
        {
          id: "A-1",
          title: "First",
          status: "Open",
          assignee: "maya",
          dueDate: "2026-10-15",
          fields: { Size: "Large", Points: "2.5", Urgent: true, Tags: ["red", "blue"] },
        },
        { id: "A-2", title: "", status: "Done" },
      ],
    });
  });

  it("numbers rows by their line in the file when there is no id column", () => {
    const bundle = csvToBundle(table, targets.map((t) => (t === "id" ? "ignore" : t)), "CSV", FIELDS);
    expect(bundle.tasks.map((t) => t.id)).toEqual(["row-2", "row-3"]);
  });
});
