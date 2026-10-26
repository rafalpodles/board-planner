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

function copyPillsAsTyped(event: ClipboardEvent) {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !event.clipboardData) return;

  const pills = [...document.querySelectorAll<HTMLElement>(PILL)].filter((el) => selection.containsNode(el, false));
  if (pills.length === 0) return;

  const html = document.createElement("div");
  for (let i = 0; i < selection.rangeCount; i++) html.append(selection.getRangeAt(i).cloneContents());
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
