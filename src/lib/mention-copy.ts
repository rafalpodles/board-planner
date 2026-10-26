const PILL = "span.mention[data-username]";

export interface CopiedPill {
  shown: string;
  username: string;
  // How many times the pill's text appears in the selection before the pill itself
  before: number;
}

const spaced = (text: string) => text.replace(/\s+/g, " ");

function occurrences(text: string, of: string): number {
  let count = 0;
  for (let at = text.indexOf(of); at >= 0 && of; at = text.indexOf(of, at + of.length)) count++;
  return count;
}

function nth(text: string, of: string, n: number): number {
  let at = text.indexOf(of);
  for (let i = 0; i < n && at >= 0; i++) at = text.indexOf(of, at + of.length);
  return at;
}

/** The selected text with each pill written back as the `@username` it was typed as. */
export function withUsernames(selected: string, pills: readonly CopiedPill[]): string {
  let text = selected;
  // Last first, so a replacement never moves the text an earlier pill is counted in
  for (const { shown, username, before } of [...pills].reverse()) {
    const name = spaced(shown);
    const at = nth(text, name, before);
    if (at < 0) continue;
    text = text.slice(0, at) + `@${username}` + text.slice(at + name.length);
  }
  return text;
}

function rangesOf(selection: Selection): Range[] {
  return Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
}

// Chrome moves a selection that starts or ends at an inline-block's edge to inside its text, so a
// pill selected whole is not "contained" by the selection; what counts is all of its text being in it
function wholeIn(ranges: Range[], pill: HTMLElement): number {
  const text = pill.firstChild;
  if (!text) return -1;
  const end = text.textContent?.length ?? 0;
  return ranges.findIndex((r) => r.isPointInRange(text, 0) && r.isPointInRange(text, end));
}

function textBefore(ranges: Range[], index: number, pill: HTMLElement): string {
  const head = ranges[index].cloneRange();
  if (pill.contains(head.startContainer)) head.collapse(true);
  else head.setEndBefore(pill);
  return [...ranges.slice(0, index).map(String), head.toString()].join("");
}

function widenedToPills(range: Range, pills: HTMLElement[]): Range {
  const wide = range.cloneRange();
  const start = pills.find((pill) => pill.contains(wide.startContainer));
  const end = pills.find((pill) => pill.contains(wide.endContainer));
  if (start) wide.setStartBefore(start);
  if (end) wide.setEndAfter(end);
  return wide;
}

function copyPillsAsTyped(event: ClipboardEvent) {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !event.clipboardData) return;

  const ranges = rangesOf(selection);
  const pills = [...document.querySelectorAll<HTMLElement>(PILL)]
    .map((el) => ({ el, range: wholeIn(ranges, el) }))
    .filter((p) => p.range >= 0);
  if (pills.length === 0) return;

  const copied = pills.map(({ el, range }) => {
    const shown = el.textContent ?? "";
    return {
      shown,
      username: el.dataset.username ?? "",
      before: occurrences(spaced(textBefore(ranges, range, el)), spaced(shown)),
    };
  });

  const html = document.createElement("div");
  const whole = pills.map((p) => p.el);
  for (const range of ranges) html.append(widenedToPills(range, whole).cloneContents());
  for (const clone of html.querySelectorAll<HTMLElement>(PILL)) {
    const selectedWhole = copied.some((p) => p.username === clone.dataset.username && p.shown === clone.textContent);
    clone.replaceWith(selectedWhole ? `@${clone.dataset.username}` : (clone.textContent ?? ""));
  }

  event.clipboardData.setData("text/plain", withUsernames(selection.toString(), copied));
  event.clipboardData.setData("text/html", html.innerHTML);
  event.preventDefault();
}

let listeners = 0;

/** While anything that draws pills is on screen, a copy puts the username back where the name is shown. */
export function listenForPillCopies(): () => void {
  if (listeners++ === 0) document.addEventListener("copy", copyPillsAsTyped);
  return () => {
    if (--listeners === 0) document.removeEventListener("copy", copyPillsAsTyped);
  };
}
