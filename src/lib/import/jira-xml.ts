import type { ImportComment } from "./bundle";
import type { CsvTable } from "./csv";

const BLOCKS = new Set(["P", "DIV", "UL", "OL", "PRE", "BLOCKQUOTE", "TABLE", "H1", "H2", "H3", "H4", "H5", "H6"]);

function inline(node: Node): string {
  if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const inner = () => [...el.childNodes].map(inline).join("");
  switch (el.tagName) {
    case "BR":
      return "\n";
    case "IMG":
      return "";
    case "TT":
    case "CODE":
      return `\`${el.textContent ?? ""}\``;
    case "B":
    case "STRONG":
      return `**${inner().trim()}**`;
    case "I":
    case "EM":
      return `*${inner().trim()}*`;
    case "A": {
      const text = inner().trim();
      const href = el.getAttribute("href") ?? "";
      return /^https?:\/\//.test(href) && text && text !== href ? `[${text}](${href})` : text || href;
    }
    default:
      return BLOCKS.has(el.tagName) ? `\n\n${block(el)}\n\n` : inner();
  }
}

function block(el: Element): string {
  const children = () => [...el.childNodes].map(inline).join("").trim();
  const heading = /^H([1-6])$/.exec(el.tagName);
  if (heading) return `${"#".repeat(+heading[1])} ${children()}`;
  if (el.tagName === "PRE") return `\`\`\`\n${el.textContent?.trim() ?? ""}\n\`\`\``;
  if (el.tagName === "BLOCKQUOTE") return children().split("\n").map((l) => `> ${l}`).join("\n");
  if (el.tagName === "UL" || el.tagName === "OL") {
    return [...el.children]
      .filter((li) => li.tagName === "LI")
      .map((li, i) => `${el.tagName === "OL" ? `${i + 1}.` : "-"} ${[...li.childNodes].map(inline).join("").trim().replace(/\n+/g, " ")}`)
      .join("\n");
  }
  if (el.tagName === "TABLE") {
    return [...el.querySelectorAll("tr")]
      .map((tr) => `| ${[...tr.children].map((c) => [...c.childNodes].map(inline).join("").trim()).join(" | ")} |`)
      .join("\n");
  }
  return children();
}

// Jira serves a description and a comment as rendered HTML; the board writes Markdown
export function htmlToMarkdown(html: string, parser: DOMParser): string {
  if (!html.trim()) return "";
  const body = parser.parseFromString(`<!doctype html><body>${html}</body>`, "text/html").body;
  return [...body.childNodes]
    .map(inline)
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

// "Tue, 18 Aug 2026 10:16:16 +0200"
function instant(raw: string): string {
  const at = new Date(raw.trim());
  return raw.trim() && !Number.isNaN(at.getTime()) ? at.toISOString() : raw.trim();
}

// A due date is a day: read it as written, not moved by the zone
function dayOf(raw: string): string {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(raw);
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) + 1 : 0;
  return m && month ? `${m[3]}-${pad(month)}-${pad(+m[1])}` : raw.trim();
}

export function isJiraXml(text: string): boolean {
  return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<rss[\s>]/.test(text) && /<item>/.test(text) && /<key[\s>]/.test(text);
}

const HEADERS = ["Issue key", "Summary", "Issue Type", "Status", "Priority", "Assignee", "Created", "Resolved", "Due date", "Parent", "Description"];

/**
 * Jira's "Export XML" holds what its CSV does and more: the parent by key and every comment on its own.
 * It is laid out as the CSV export would be, so the same mapping step, report and re-upload apply.
 */
export function jiraXmlToTable(text: string, parser: DOMParser): CsvTable | null {
  const doc = parser.parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  const items = [...doc.getElementsByTagName("item")];
  const own = (item: Element, tag: string) => [...item.children].find((c) => c.tagName === tag) ?? null;
  const textOf = (item: Element, tag: string) => own(item, tag)?.textContent?.trim() ?? "";

  // A comment names its author by account id; the people the file names elsewhere give the name
  const names = new Map<string, string>();
  for (const person of [...doc.getElementsByTagName("assignee"), ...doc.getElementsByTagName("reporter")]) {
    const id = person.getAttribute("accountid") ?? person.getAttribute("username");
    if (id && person.textContent?.trim()) names.set(id, person.textContent.trim());
  }

  const rows = items.map((item) => {
    const labels = [...(own(item, "labels")?.getElementsByTagName("label") ?? [])].map((l) => l.textContent?.trim() ?? "").filter(Boolean);
    // Known by Jira's own comment id, so a re-export updates it however its author is named this time
    const comments: ImportComment[] = [...(own(item, "comments")?.getElementsByTagName("comment") ?? [])].map((c, i) => {
      const author = c.getAttribute("author") ?? "";
      const created = instant(c.getAttribute("created") ?? "");
      return {
        id: c.getAttribute("id") ? `jira-${c.getAttribute("id")}` : `xml-c${i + 1}`,
        body: htmlToMarkdown(c.textContent ?? "", parser),
        ...(created && { createdAt: created }),
        ...((names.get(author) ?? author) && { author: names.get(author) ?? author }),
      };
    });
    const assignee = own(item, "assignee");
    return {
      cells: [
        textOf(item, "key"),
        textOf(item, "summary"),
        textOf(item, "type"),
        textOf(item, "status"),
        textOf(item, "priority"),
        assignee && assignee.getAttribute("accountid") !== "-1" ? (assignee.textContent?.trim() ?? "") : "",
        instant(textOf(item, "created")),
        instant(textOf(item, "resolved")),
        dayOf(textOf(item, "due")),
        textOf(item, "parent"),
        htmlToMarkdown(own(item, "description")?.textContent ?? "", parser),
      ],
      labels,
      comments,
    };
  });

  const labelColumns = Math.max(0, ...rows.map((r) => r.labels.length));
  const fill = (values: string[], n: number) => [...values, ...Array(n - values.length).fill("")];
  return {
    headers: [...HEADERS, ...Array(labelColumns).fill("Labels")],
    rows: rows.map((r) => [...r.cells, ...fill(r.labels, labelColumns)]),
    comments: rows.map((r) => r.comments),
  };
}
