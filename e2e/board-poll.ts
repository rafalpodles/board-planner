import type { Page } from "@playwright/test";
import { BOARD_POLL_MS } from "@/lib/board-poll";

/**
 * Drops the board's ten-second poll before the page loads, so a card that moves or vanishes was
 * moved by the code under test and not by the next refetch. Only intervals of exactly that period
 * are dropped; the board's own reload after a write still runs. Call before the first navigation.
 */
export async function silenceBoardPoll(page: Page) {
  await page.addInitScript((period) => {
    const original = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      timeout === period ? 0 : original(handler, timeout, ...args)) as typeof window.setInterval;
  }, BOARD_POLL_MS);
}
