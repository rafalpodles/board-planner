// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { readXlsxTable } from "./xlsx";

// A minimal zip writer, so a workbook can be built in the test the way Excel and Jira store one
function zip(files: Record<string, string>, { deflate = true } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf-8");
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const workbook = (sheets: string) => `<?xml version="1.0"?><workbook ${NS}><sheets>${sheets}</sheets></workbook>`;
const rels = (targets: [string, string][]) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${targets
    .map(([id, target]) => `<Relationship Id="${id}" Target="${target}"/>`)
    .join("")}</Relationships>`;

describe("readXlsxTable", () => {
  it("reads Jira's workbook: inline strings with no cell references, from the first sheet", async () => {
    const row = (...v: string[]) => `<row>${v.map((x) => `<c t="str"><v>${x}</v></c>`).join("")}</row>`;
    const bytes = zip({
      "xl/workbook.xml": workbook('<sheet name="Fields" sheetId="1" r:id="rId2"/><sheet name="Activity" sheetId="2" r:id="rId3"/>'),
      "xl/_rels/workbook.xml.rels": rels([["rId2", "worksheets/sheet1.xml"], ["rId3", "worksheets/sheet2.xml"]]),
      "xl/worksheets/sheet1.xml": `<worksheet ${NS}><sheetData>${row("Summary", "Issue key", "Created")}${row("Zażółć &amp; co", "ORB-1", "18/Aug/26 10:16 AM")}</sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": `<worksheet ${NS}><sheetData>${row("Type")}${row("HISTORY")}</sheetData></worksheet>`,
    });
    expect(await readXlsxTable(bytes, new DOMParser())).toEqual({
      headers: ["Summary", "Issue key", "Created"],
      rows: [["Zażółć & co", "ORB-1", "18/Aug/26 10:16 AM"]],
    });
  });

  it("reads Excel's own: shared strings, numbers, cell references that skip a column, and stored entries", async () => {
    const bytes = zip(
      {
        "xl/workbook.xml": workbook('<sheet name="S" sheetId="1" r:id="rId1"/>'),
        "xl/_rels/workbook.xml.rels": rels([["rId1", "/xl/worksheets/data.xml"]]),
        "xl/sharedStrings.xml": `<sst ${NS}><si><t>Title</t></si><si><r><t>Two </t></r><r><t>runs</t></r></si><si><t>Points</t></si></sst>`,
        "xl/worksheets/data.xml": `<worksheet ${NS}><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row>
          <row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>2.5</v></c></row>
          <row r="3"><c r="A3" t="inlineStr"><is><t>Inline</t></is></c></row>
        </sheetData></worksheet>`,
      },
      { deflate: false }
    );
    expect(await readXlsxTable(bytes, new DOMParser())).toEqual({
      headers: ["Title", "", "Points"],
      rows: [["Two runs", "", "2.5"], ["Inline"]],
    });
  });

  it("marks a Jira workbook's text as Jira's wiki markup", async () => {
    const row = (...v: string[]) => `<row>${v.map((x) => `<c t="str"><v>${x}</v></c>`).join("")}</row>`;
    const bytes = zip({
      "xl/workbook.xml": workbook('<sheet name="F" sheetId="1" r:id="rId1"/>'),
      "xl/_rels/workbook.xml.rels": rels([["rId1", "worksheets/sheet1.xml"]]),
      "xl/worksheets/sheet1.xml": `<worksheet ${NS}><sheetData>${row("Summary", "Issue key", "Issue Type")}${row("a", "X-1", "Bug")}</sheetData></worksheet>`,
    });
    expect((await readXlsxTable(bytes, new DOMParser())).markup).toBe("jira-wiki");
  });

  it("refuses a file that is not a zip", async () => {
    await expect(readXlsxTable(new TextEncoder().encode("PK but not really"), new DOMParser())).rejects.toThrow();
  });
});
