import { expect, type Page } from "@playwright/test";

/**
 * A toast clears itself before a poll can see it, so the page records every one it shows: the
 * same MutationObserver trick kanban-board-core and run-conflict carry locally.
 */
export async function recordToasts(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = ((window as unknown as { __toasts?: string[] }).__toasts = []);
    const collect = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      const added = node.matches('[data-testid="toast"]')
        ? [node]
        : Array.from(node.querySelectorAll('[data-testid="toast"]'));
      for (const toast of added) seen.push(toast.textContent ?? "");
    };
    new MutationObserver((records) =>
      records.forEach((record) => record.addedNodes.forEach(collect))
    ).observe(document.body, { childList: true, subtree: true });
  });
}

export function expectToast(page: Page, message: string) {
  return expect
    .poll(() => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts))
    .toContain(message);
}

export function recordedToasts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __toasts?: string[] }).__toasts ?? []);
}

/**
 * `recordToasts` for a toast that may fire while the page is still loading: installed before any
 * navigation, it records from the first paint. Read it back with `recordedToasts`.
 */
export async function recordToastsFromLoad(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = ((window as unknown as { __toasts?: string[] }).__toasts = []);
    const collect = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      const added = node.matches('[data-testid="toast"]')
        ? [node]
        : Array.from(node.querySelectorAll('[data-testid="toast"]'));
      for (const toast of added) seen.push(toast.textContent ?? "");
    };
    new MutationObserver((records) =>
      records.forEach((record) => record.addedNodes.forEach(collect))
    ).observe(document, { childList: true, subtree: true });
  });
}
