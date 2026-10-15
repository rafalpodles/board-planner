// Jira's CSV and Excel exports carry a description and a comment in its wiki markup; the board writes Markdown
export function jiraWikiToMarkdown(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const opens = /^\s*\{(code|noformat)(?::[^}]*)?\}(.*)$/.exec(raw);
    if (fence) {
      const closes = raw.indexOf(`{${fence}}`);
      if (closes >= 0) {
        if (raw.slice(0, closes).trim()) out.push(raw.slice(0, closes));
        out.push("```");
        fence = null;
      } else out.push(raw);
      continue;
    }
    if (opens) {
      const lang = /^\{code:([a-z0-9+#-]+)\}/i.exec(raw.trim())?.[1] ?? "";
      out.push(`\`\`\`${lang}`);
      const rest = opens[2];
      const closes = rest.indexOf(`{${opens[1]}}`);
      if (closes >= 0) {
        if (rest.slice(0, closes).trim()) out.push(rest.slice(0, closes));
        out.push("```");
      } else {
        if (rest.trim()) out.push(rest);
        fence = opens[1];
      }
      continue;
    }
    out.push(line(raw));
  }
  if (fence) out.push("```");
  return out.join("\n");
}

function line(raw: string): string {
  const heading = /^\s*h([1-6])\.\s+(.*)$/.exec(raw);
  if (heading) return `${"#".repeat(+heading[1])} ${inline(heading[2])}`;
  const quote = /^\s*bq\.\s+(.*)$/.exec(raw);
  if (quote) return `> ${inline(quote[1])}`;
  const list = /^\s*([*#]+|-)\s+(.*)$/.exec(raw);
  if (list && !/^\*[^*\s][^*]*\*(\s|$)/.test(raw.trim())) {
    const depth = list[1].length - 1;
    const marker = list[1].endsWith("#") ? "1." : "-";
    return `${"  ".repeat(depth)}${marker} ${inline(list[2])}`;
  }
  if (/^\s*\{quote\}\s*$/.test(raw)) return "";
  return inline(raw);
}

function inline(text: string): string {
  return text
    .replace(/\{\{(.+?)\}\}/g, "`$1`")
    .replace(/\[([^|\]]+)\|(https?:\/\/[^\]\s]+)\]/g, "[$1]($2)")
    .replace(/\[(https?:\/\/[^\]\s|]+)\]/g, "$1")
    .replace(/(^|[\s(])\*(\S(?:[^*]*\S)?)\*(?=[\s).,;:!?]|$)/g, "$1**$2**")
    .replace(/(^|[\s(])_(\S(?:[^_]*\S)?)_(?=[\s).,;:!?]|$)/g, "$1*$2*")
    .replace(/(^|[\s(])-(\S(?:[^-]*\S)?)-(?=[\s).,;:!?]|$)/g, "$1~~$2~~")
    .replace(/\{color(?::[^}]*)?\}/g, "")
    .replace(/\[~(?:accountid:)?([^\]]+)\]/g, "@$1");
}
