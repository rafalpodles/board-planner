import { type CsvTable, withMarkup } from "./csv";

// Enough of a zip reader for one workbook: the central directory, then stored or deflated entries
async function entries(bytes: Uint8Array, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, string>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("a broken zip directory");
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    if (!wanted(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, new TextDecoder().decode(data));
    else if (method === 8) {
      const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out.set(name, await new Response(stream).text());
    } else throw new Error("a zip method this reader does not know");
  }
  return out;
}

function column(ref: string | null): number | null {
  const letters = ref && /^([A-Z]+)\d*$/.exec(ref)?.[1];
  if (!letters) return null;
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

// OOXML writes a control character such as CR as _x000D_
const text = (el: Element | undefined | null) => unescapeXml(el?.textContent ?? "");
const unescapeXml = (value: string) => value.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

// Excel keeps a date as a number of days since 1899-12-30, and only its cell's format says it is one
const BUILT_IN_DATES = new Map<number, boolean>([
  [14, false], [15, false], [16, false], [17, false], [22, true], [45, true], [46, true], [47, true], [18, true], [19, true], [20, true], [21, true],
]);

function datedStyles(styles: Document | null): Map<number, boolean> {
  const out = new Map<number, boolean>();
  if (!styles) return out;
  const custom = new Map(
    [...styles.getElementsByTagName("numFmt")].map((f) => [Number(f.getAttribute("numFmtId")), f.getAttribute("formatCode") ?? ""])
  );
  const xfs = styles.getElementsByTagName("cellXfs")[0];
  [...(xfs?.getElementsByTagName("xf") ?? [])].forEach((xf, index) => {
    const id = Number(xf.getAttribute("numFmtId") ?? 0);
    if (BUILT_IN_DATES.has(id)) return out.set(index, BUILT_IN_DATES.get(id)!);
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "").toLowerCase();
    if (/[dy]/.test(code) || (/m/.test(code) && /[dyh]/.test(code))) out.set(index, /h|s/.test(code));
  });
  return out;
}

function fromSerial(serial: number, withTime: boolean): string {
  if (!Number.isFinite(serial)) return String(serial);
  const at = new Date(Math.round((serial - 25569) * 86_400_000));
  return withTime ? at.toISOString().replace(/\.000Z$/, "Z") : at.toISOString().slice(0, 10);
}

/** The first sheet of an .xlsx workbook as a table: its first row the headers, every cell as text */
export async function readXlsxTable(bytes: Uint8Array, parser: DOMParser): Promise<CsvTable> {
  const files = await entries(bytes, (name) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(name));
  const xml = (name: string) => (files.has(name) ? parser.parseFromString(files.get(name)!, "application/xml") : null);

  const workbook = xml("xl/workbook.xml");
  const firstSheet = workbook?.getElementsByTagName("sheet")[0];
  const relId = firstSheet?.getAttribute("r:id") ?? firstSheet?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  const target = [...(xml("xl/_rels/workbook.xml.rels")?.getElementsByTagName("Relationship") ?? [])]
    .find((r) => r.getAttribute("Id") === relId)
    ?.getAttribute("Target");
  const sheetName = target ? `xl/${target.replace(/^\/?xl\//, "")}` : "xl/worksheets/sheet1.xml";
  const sheet = xml(sheetName) ?? xml("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("no worksheet");

  const shared = [...(xml("xl/sharedStrings.xml")?.getElementsByTagName("si") ?? [])].map((si) =>
    [...si.getElementsByTagName("t")].map((t) => text(t)).join("")
  );

  const dateStyles = datedStyles(xml("xl/styles.xml"));
  const rows = [...sheet.getElementsByTagName("row")].map((row) => {
    const cells: string[] = [];
    let next = 0;
    for (const c of [...row.getElementsByTagName("c")]) {
      const index = column(c.getAttribute("r")) ?? next;
      const type = c.getAttribute("t");
      const value = text(c.getElementsByTagName("v")[0]);
      const style = Number(c.getAttribute("s") ?? -1);
      cells[index] =
        type === "s"
          ? (shared[Number(value)] ?? "")
          : type === "inlineStr"
            ? text(c.getElementsByTagName("is")[0])
            : !type && value && dateStyles.has(style)
              ? fromSerial(Number(value), dateStyles.get(style)!)
              : value;
      next = index + 1;
    }
    return Array.from(cells, (v) => v ?? "");
  });
  const [headers = [], ...body] = rows.filter((r) => r.some((v) => v.trim() !== ""));
  return withMarkup({ headers: headers.map((h) => h.trim()), rows: body });
}
