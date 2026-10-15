// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { zip } from "../../../e2e/zip";
import { readXlsxTable } from "./xlsx";

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
