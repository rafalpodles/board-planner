import { describe, it, expect } from "vitest";
import { csvToBundle, decodeCsv, detectDelimiter, guessTargets, isJiraExport, normaliseDay, normaliseInstant, parseCsv, readCsvTable } from "./csv";
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

  it("reads UTF-16 by its byte-order mark, as Excel's Unicode Text is saved", () => {
    const le = new Uint8Array([0xff, 0xfe, ...[..."Tytuł;a"].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])]);
    expect(decodeCsv(le)).toBe("Tytuł;a");
    const be = new Uint8Array([0xfe, 0xff, ...[..."Zażółć"].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff])]);
    expect(decodeCsv(be)).toBe("Zażółć");
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

  it("reads a quoted first header after a byte-order mark", () => {
    expect(readCsvTable('\ufeff"Key";Title\nA-1;x').headers).toEqual(["Key", "Title"]);
  });

  it("skips blank lines and reads a last line with no line break", () => {
    expect(parseCsv("a,b\n\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("stores a formula as the text it is, never its value", () => {
    const table = readCsvTable('Title\n"=HYPERLINK(""http://evil"",""x"")"\n+1+1');
    const bundle = csvToBundle(table, ["title"], "CSV", [], "u1");
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

describe("normaliseInstant", () => {
  it.each([
    ["2026-10-15T08:00:00+02:00", "2026-10-15T08:00:00+02:00"],
    ["2026-10-15 08:00", "2026-10-15T08:00:00Z"],
    ["2026-10-15T8:05", "2026-10-15T08:05:00Z"],
    ["2026-10-15 08:00 +02:00", "2026-10-15T08:00:00+02:00"],
    ["2026-10-15Tjunk", "2026-10-15Tjunk"],
    ["2026-10-15T08:00:00+02", "2026-10-15T08:00:00+02:00"],
    ["2026-10-15T08:00:00,5Z", "2026-10-15T08:00:00.5Z"],
    ["2026-02-31T08:00", "2026-02-31T08:00"],
    ["2026-10-15T08:00:00+2", "2026-10-15T08:00:00+2"],
    ["15.10.2026 08:30", "2026-10-15T08:30:00Z"],
    ["15.10.2026", "2026-10-15T00:00:00Z"],
    ["25/12/2026 10:00", "2026-12-25T10:00:00Z"],
    ["05/10/2026", "05/10/2026"],
  ])("%s becomes %s", (raw, at) => expect(normaliseInstant(raw)).toBe(at));
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
    const bundle = csvToBundle(table, targets, "CSV", FIELDS, "u1");
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

  it("gives a row with a blank id one only this upload can match", () => {
    const blank = readCsvTable("Key,Title\nA,One\n,Two");
    const bundle = csvToBundle(blank, ["id", "title"], "CSV", [], "u1");
    expect(bundle.tasks.map((t) => t.id)).toEqual(["A", "u1-row-3"]);
  });

  it("numbers rows by their line in the file when there is no id column", () => {
    const bundle = csvToBundle(table, targets.map((t) => (t === "id" ? "ignore" : t)), "CSV", FIELDS, "u1");
    expect(bundle.tasks.map((t) => t.id)).toEqual(["row-2", "row-3"]);
  });
});

describe("a Jira export", () => {
  const JIRA = [
    "Summary,Issue key,Issue id,Issue Type,Status,Priority,Assignee,Created,Resolved,Due date,Labels,Labels,Description,Comment,Comment,Parent",
    'Export invoices,ORB-12,10012,Bug,Done,Highest,Maya Kowalska,15/Oct/25 9:30 AM,16/Oct/25 1:05 PM,20/paź/26,billing,urgent-fix,"Line 1\nLine 2","15/Oct/25 9:45 AM;712020:abc;First comment","16/Oct/25 12:05 AM;712020:def;Second; with a semicolon",10010',
    "Plain one,ORB-13,10013,Story,To Do,Medium,,01/Jan/26 12:00 PM,,,,,,just text with no date,,",
  ].join("\n");
  const fields = [{ name: "Labels", fieldType: "multiselect" }];
  const table = readCsvTable(JIRA);
  const targets = guessTargets(table.headers, fields);

  it("is recognised by its headers, and its columns are guessed with repeats kept", () => {
    expect(isJiraExport(table.headers)).toBe(true);
    expect(isJiraExport(["Title", "Status"])).toBe(false);
    expect(targets).toEqual([
      "title", "id", "ignore", "category", "status", "priority", "assignee", "createdAt", "completedAt", "dueDate",
      "field:Labels", "field:Labels", "description", "comment", "comment", "parent",
    ]);
  });

  it("carries Jira's dates, both label columns, every comment with its time and author, and the parent", () => {
    const bundle = csvToBundle(table, targets, "Jira", fields, "u1");
    expect(parseBundle(bundle).ok).toBe(true);
    expect(bundle.tasks[0]).toEqual({
      id: "ORB-12",
      title: "Export invoices",
      description: "Line 1\nLine 2",
      status: "Done",
      assignee: "Maya Kowalska",
      priority: "Highest",
      type: "Bug",
      dueDate: "2026-10-20",
      createdAt: "2025-10-15T09:30:00Z",
      completedAt: "2025-10-16T13:05:00Z",
      parent: "10010",
      fields: { Labels: ["billing", "urgent-fix"] },
      comments: [
        { id: "2025-10-15T09:45:00Z|712020:abc", createdAt: "2025-10-15T09:45:00Z", author: "712020:abc", body: "First comment" },
        { id: "2025-10-16T00:05:00Z|712020:def", createdAt: "2025-10-16T00:05:00Z", author: "712020:def", body: "Second; with a semicolon" },
      ],
    });
    expect(bundle.tasks[1].comments).toEqual([{ id: "c1", body: "just text with no date" }]);
    expect(bundle.tasks[1].createdAt).toBe("2026-01-01T12:00:00Z");
  });

  it("keeps a comment's identity when an earlier one is deleted in Jira, and tells two in the same minute apart", () => {
    const sheet = (cells: string[]) => readCsvTable(["Issue key,Summary,Comment,Comment,Comment", ["X-1", "t", ...cells].map((c) => `"${c}"`).join(",")].join("\n"));
    const ids = (cells: string[]) => csvToBundle(sheet(cells), ["id", "title", "comment", "comment", "comment"], "Jira", [], "u1").tasks[0].comments!.map((c) => c.id);
    const [a, b, c] = ["01/Jan/26 9:00 AM;u1;one", "01/Jan/26 9:00 AM;u1;two", "02/Jan/26 9:00 AM;u2;three"];
    expect(ids([a, b, c])).toEqual(["2026-01-01T09:00:00Z|u1", "2026-01-01T09:00:00Z|u1#2", "2026-01-02T09:00:00Z|u2"]);
    expect(ids([a, c, ""])).toEqual(["2026-01-01T09:00:00Z|u1", "2026-01-02T09:00:00Z|u2"]);
  });

  it.each([
    ["15/Oct/26", "2026-10-15"],
    ["5/maj/2026", "2026-05-05"],
    ["31/Feb/26", "31/Feb/26"],
    ["15/Foo/26", "15/Foo/26"],
  ])("reads the day %s as %s", (raw, day) => expect(normaliseDay(raw)).toBe(day));

  it.each([
    ["15/Oct/26 12:00 AM", "2026-10-15T00:00:00Z"],
    ["15/Oct/26 12:30 PM", "2026-10-15T12:30:00Z"],
    ["15/Oct/26 17:30", "2026-10-15T17:30:00Z"],
    ["15/Oct/26 13:00 PM", "15/Oct/26 13:00 PM"],
  ])("reads the time %s as %s", (raw, at) => expect(normaliseInstant(raw)).toBe(at));
});
