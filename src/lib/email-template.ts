import { APP_NAME } from "@/lib/brand";
import { ColumnRole } from "@/types";

export type PillTone = "todo" | "progress" | "review" | "human" | "done" | "neutral";

export type Pill = { label: string; tone?: PillTone } | "arrow";

export interface EmailTaskCard {
  key: string;
  title: string;
  url?: string;
  pills?: Pill[];
  meta?: string;
}

export interface EmailContent {
  /** First line mail clients show next to the subject in the list. */
  preheader: string;
  kicker: string;
  heading?: string;
  intro?: string[];
  alert?: { tone: "warning" | "success"; lines: string[] };
  taskCard?: EmailTaskCard;
  quote?: { who: string; text: string };
  rows?: { label: string; value: string }[];
  outro?: string[];
  button?: { label: string; url: string };
  secondaryButton?: { label: string; url: string };
  /** Repeats the primary button's target as text, for the clients that drop the button. */
  showButtonUrl?: boolean;
  footer: string[];
  footerLinks?: { label: string; url: string }[];
}

const PILL_COLOURS: Record<PillTone, { fg: string; bg: string }> = {
  todo: { fg: "#1d4ed8", bg: "#e6edff" },
  progress: { fg: "#92400e", bg: "#fdf0da" },
  review: { fg: "#7e22ce", bg: "#f4e8ff" },
  human: { fg: "#be123c", bg: "#ffe6ec" },
  done: { fg: "#166534", bg: "#dcf5e3" },
  neutral: { fg: "#475569", bg: "#eef2f7" },
};

const ROLE_TONES: Record<ColumnRole, PillTone> = {
  backlog: "neutral",
  approved: "todo",
  active: "progress",
  review: "review",
  blocked: "human",
  done: "done",
};

export function pillToneForRole(role: ColumnRole | undefined): PillTone {
  return role ? ROLE_TONES[role] : "neutral";
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A link that is neither http nor https is dropped rather than rendered: the values reaching here
 * come from configuration and from the database, and `javascript:` in an anchor is one stored
 * string away from being somebody else's click.
 */
export function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

function paragraph(text: string): string {
  return `<p class="body" style="margin:0 0 14px;color:#3c485c;font-size:15px;line-height:1.55">${escapeHtml(text)}</p>`;
}

function renderPills(pills: Pill[]): string {
  return pills
    .map((pill) => {
      if (pill === "arrow") {
        return `<span style="color:#94a3b8;font-size:12px;padding:0 2px">&rarr;</span>`;
      }
      const { fg, bg } = PILL_COLOURS[pill.tone ?? "neutral"];
      return `<span class="pill pill-${pill.tone ?? "neutral"}" style="display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;color:${fg};background:${bg}">${escapeHtml(pill.label)}</span>`;
    })
    .join("&nbsp;");
}

function renderTaskCard(card: EmailTaskCard): string {
  const url = safeUrl(card.url);
  const title = escapeHtml(card.title);
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">`,
    `<tr><td class="taskcard" style="background:#fbfcfe;border:1px solid #e2e8f2;border-left:3px solid #2563eb;border-radius:6px;padding:14px 16px">`,
    `<div style="margin:0 0 7px"><span class="key" style="font-family:${MONO};font-size:11.5px;font-weight:700;color:#475569">${escapeHtml(card.key)}</span>&nbsp;&nbsp;${renderPills(card.pills ?? [])}</div>`,
    `<div class="tasktitle" style="font-size:15.5px;font-weight:600;color:#16203a;line-height:1.35;margin:0 0 5px">`,
    url ? `<a href="${escapeHtml(url)}" style="color:#16203a;text-decoration:none">${title}</a>` : title,
    `</div>`,
    card.meta
      ? `<div class="muted" style="font-size:12.5px;color:#6b7688">${escapeHtml(card.meta)}</div>`
      : "",
    `</td></tr></table>`,
  ].join("");
}

function renderButton(label: string, url: string, primary: boolean): string {
  const style = primary
    ? "background:#2563eb;color:#ffffff;border:1px solid #2563eb"
    : "background:#ffffff;color:#1d4ed8;border:1px solid #c7d5f3";
  return `<a href="${escapeHtml(url)}" class="btn" style="display:inline-block;${style};text-decoration:none;font-size:14.5px;font-weight:600;padding:10px 20px;border-radius:6px;font-family:${FONT}">${escapeHtml(label)}</a>`;
}

const DARK_MODE_CSS = `
@media (prefers-color-scheme: dark) {
  body, .wrapper { background:#0c1119 !important; }
  .card { background:#131a26 !important; border-color:#2b3648 !important; }
  .rule { border-color:#232d3d !important; }
  .wordmark { color:#c8d4e6 !important; }
  .heading, .tasktitle, .tasktitle a { color:#f2f6fb !important; }
  .body { color:#b8c4d6 !important; }
  .muted, .kicker, .foot, .foot p { color:#8896ab !important; }
  .key { color:#9aa8bd !important; }
  .taskcard { background:#182131 !important; border-color:#2b3648 !important; border-left-color:#60a5fa !important; }
  .quote { border-left-color:#33415a !important; color:#aebbcd !important; }
  .foot { background:#131a26 !important; }
  .foot a { color:#8fa3c0 !important; }
  .rowtable td { border-color:#232d3d !important; }
  .rowlabel { color:#8896ab !important; }
  .rowvalue { color:#d6e0ee !important; }
  .pill-todo { color:#93b8ff !important; background:#1b2b4d !important; }
  .pill-progress { color:#fbbf24 !important; background:#382a12 !important; }
  .pill-review { color:#d8b4fe !important; background:#2f2043 !important; }
  .pill-human { color:#fda4af !important; background:#3f1a25 !important; }
  .pill-done { color:#86efac !important; background:#14311f !important; }
  .pill-neutral { color:#9fb0c7 !important; background:#222c3d !important; }
}`;

export function renderEmail(content: EmailContent): { html: string; text: string } {
  return { html: renderHtml(content), text: renderText(content) };
}

function renderHtml(c: EmailContent): string {
  const body: string[] = [];

  body.push(
    `<div class="kicker" style="font-size:11px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#64748b;margin:0 0 10px">${escapeHtml(c.kicker)}</div>`
  );
  if (c.heading) {
    body.push(
      `<h1 class="heading" style="margin:0 0 14px;font-size:21px;line-height:1.25;font-weight:600;color:#0f172a">${escapeHtml(c.heading)}</h1>`
    );
  }
  for (const line of c.intro ?? []) body.push(paragraph(line));

  if (c.alert) {
    const tone =
      c.alert.tone === "warning"
        ? "border:1px solid #f0dcb6;background:#fdf7ec;color:#6b4a12"
        : "border:1px solid #c4e6cf;background:#f0faf3;color:#1c5334";
    body.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="${tone};border-radius:6px;padding:13px 15px;font-size:14px;line-height:1.5">${c.alert.lines
        .map(escapeHtml)
        .join("<br>")}</td></tr></table>`
    );
  }

  if (c.taskCard) body.push(renderTaskCard(c.taskCard));

  if (c.quote) {
    body.push(
      [
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">`,
        `<tr><td class="quote" style="border-left:2px solid #dbe3ee;padding:2px 0 2px 14px;color:#47536a;font-size:14.5px;line-height:1.55">`,
        `<div class="muted" style="font-size:12px;color:#7b8698;margin:0 0 4px">${escapeHtml(c.quote.who)}</div>`,
        escapeHtml(c.quote.text),
        `</td></tr></table>`,
      ].join("")
    );
  }

  if (c.rows?.length) {
    body.push(
      [
        `<table role="presentation" class="rowtable" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;font-family:${MONO};font-size:13px">`,
        ...c.rows.map(
          (row) =>
            `<tr><td class="rowlabel" style="padding:6px 0;border-bottom:1px solid #eef1f6;color:#7b8698;width:34%;vertical-align:top">${escapeHtml(row.label)}</td>` +
            `<td class="rowvalue" style="padding:6px 0;border-bottom:1px solid #eef1f6;color:#26324a;vertical-align:top;word-break:break-word">${escapeHtml(row.value)}</td></tr>`
        ),
        `</table>`,
      ].join("")
    );
  }

  // The action comes before whatever reassures the reader about it: an "if it wasn't you" line
  // sitting above the button reads as a reason not to press it.
  const primary = safeUrl(c.button?.url);
  const secondary = safeUrl(c.secondaryButton?.url);
  if (c.button && primary) {
    const buttons = [renderButton(c.button.label, primary, true)];
    if (c.secondaryButton && secondary) {
      buttons.push(renderButton(c.secondaryButton.label, secondary, false));
    }
    body.push(`<div style="margin:4px 0 0">${buttons.join("&nbsp;&nbsp;")}</div>`);
    if (c.showButtonUrl) {
      body.push(
        `<p class="muted" style="margin:16px 0 0;font-size:12px;color:#7b8698;word-break:break-all">Or paste this into your browser:<br>${escapeHtml(primary)}</p>`
      );
    }
  }

  for (const line of c.outro ?? []) {
    body.push(
      `<p class="body" style="margin:18px 0 0;color:#3c485c;font-size:15px;line-height:1.55">${escapeHtml(line)}</p>`
    );
  }

  const footer = [
    ...c.footer.map(
      (line) =>
        `<p style="margin:0 0 5px;color:#7b8698;font-size:12px;line-height:1.5">${escapeHtml(line)}</p>`
    ),
  ];
  const links = (c.footerLinks ?? [])
    .map((link) => ({ label: link.label, url: safeUrl(link.url) }))
    .filter((link): link is { label: string; url: string } => !!link.url);
  if (links.length) {
    footer.push(
      `<p style="margin:0;color:#7b8698;font-size:12px;line-height:1.5">${links
        .map(
          (link) =>
            `<a href="${escapeHtml(link.url)}" style="color:#5b6b86">${escapeHtml(link.label)}</a>`
        )
        .join(" &middot; ")}</p>`
    );
  }

  return [
    `<!doctype html><html><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">`,
    `<style>${DARK_MODE_CSS}</style></head>`,
    `<body style="margin:0;padding:0;background:#eef1f5">`,
    `<div style="display:none;font-size:1px;color:#eef1f5;max-height:0;overflow:hidden">${escapeHtml(c.preheader)}</div>`,
    `<table role="presentation" class="wrapper" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:22px 12px">`,
    `<tr><td align="center">`,
    `<table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #dde3ec;border-radius:8px;font-family:${FONT};color:#1a2233">`,
    `<tr><td class="rule" style="padding:16px 26px;border-bottom:1px solid #edf1f6">`,
    `<table role="presentation" cellpadding="0" cellspacing="0"><tr>`,
    `<td style="width:24px;height:24px;background:#2563eb;border-radius:6px;text-align:center;font-family:${MONO};font-size:11px;font-weight:700;color:#ffffff">BP</td>`,
    `<td style="padding-left:9px"><span class="wordmark" style="font-size:13.5px;font-weight:600;color:#33405a">${escapeHtml(APP_NAME)}</span></td>`,
    `</tr></table></td></tr>`,
    `<tr><td style="padding:26px">${body.join("")}</td></tr>`,
    `<tr><td class="foot rule" style="border-top:1px solid #edf1f6;background:#fcfdfe;padding:16px 26px 20px">${footer.join("")}</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join("");
}

function renderText(c: EmailContent): string {
  const blocks: string[] = [];
  const buttonUrl = safeUrl(c.button?.url);

  if (c.heading) blocks.push(c.heading);
  for (const line of c.intro ?? []) blocks.push(line);
  if (c.alert) blocks.push(c.alert.lines.join("\n"));

  if (c.taskCard) {
    const pills = (c.taskCard.pills ?? [])
      .map((pill) => (pill === "arrow" ? "→" : pill.label))
      .join(" ");
    const card = [`${c.taskCard.key}${pills ? ` · ${pills}` : ""}`, c.taskCard.title];
    if (c.taskCard.meta) card.push(c.taskCard.meta);
    const url = safeUrl(c.taskCard.url);
    // The button below carries the same address; printing it twice is noise in a text part
    if (url && url !== buttonUrl) card.push(url);
    blocks.push(card.join("\n"));
  }

  if (c.quote) {
    blocks.push([c.quote.who, ...c.quote.text.split("\n")].map((l) => `> ${l}`).join("\n"));
  }

  if (c.rows?.length) {
    blocks.push(c.rows.map((row) => `${row.label}: ${row.value}`).join("\n"));
  }

  const primary = buttonUrl;
  if (c.button && primary) blocks.push(`${c.button.label}: ${primary}`);
  const secondary = safeUrl(c.secondaryButton?.url);
  if (c.secondaryButton && secondary) blocks.push(`${c.secondaryButton.label}: ${secondary}`);

  for (const line of c.outro ?? []) blocks.push(line);

  const footer = [...c.footer];
  for (const link of c.footerLinks ?? []) {
    const url = safeUrl(link.url);
    if (url) footer.push(`${link.label}: ${url}`);
  }
  blocks.push(`--\n${footer.join("\n")}`);

  return blocks.join("\n\n");
}
