import { expect, type Page } from "@playwright/test";

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
