const PILL = "span.mention[data-username]";

export interface CopiedPill {
  shown: string;
  username: string;
}

/** The selected text with each pill, in order, written back as the `@username` it was typed as. */
export function withUsernames(selected: string, pills: readonly CopiedPill[]): string {
  let text = selected;
  let from = 0;
  for (const { shown, username } of pills) {
    const at = text.indexOf(shown, from);
    if (at < 0) continue;
    const typed = `@${username}`;
    text = text.slice(0, at) + typed + text.slice(at + shown.length);
    from = at + typed.length;
  }
  return text;
}

function rangesOf(selection: Selection): Range[] {
  return Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
}

// Chrome moves a selection that starts or ends at an inline-block's edge to inside its text, so a
// pill selected whole is not "contained" by the selection; what counts is all of its text being in it
function wholeIn(ranges: Range[], pill: HTMLElement): boolean {
  const text = pill.firstChild;
  if (!text) return false;
  const end = text.textContent?.length ?? 0;
  return ranges.some((r) => r.isPointInRange(text, 0) && r.isPointInRange(text, end));
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
  const pills = [...document.querySelectorAll<HTMLElement>(PILL)].filter((el) => wholeIn(ranges, el));
  if (pills.length === 0) return;

  const html = document.createElement("div");
  for (const range of ranges) html.append(widenedToPills(range, pills).cloneContents());
  for (const pill of html.querySelectorAll<HTMLElement>(PILL)) pill.replaceWith(`@${pill.dataset.username}`);

  event.clipboardData.setData(
    "text/plain",
    withUsernames(
      selection.toString(),
      pills.map((el) => ({ shown: el.textContent ?? "", username: el.dataset.username ?? "" }))
    )
  );
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
