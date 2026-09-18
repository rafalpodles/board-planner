// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { Modal } from "@/components/ui/Modal";
import { PmChatWidget } from "./PmChatWidget";
import { OWNS_ITS_KEYS } from "@/lib/keyboard-scope";

/**
 * BP-589. At phone width a dialog is a bottom sheet, and this launcher was painted at the same
 * z-50 over its action row: at equal z the one rendered last wins, and this is rendered after the
 * page. On a right-aligned footer it covered the primary button's own corner, so a finger there
 * opened the PM chat instead of pressing the button under it.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("next/navigation", () => ({ usePathname: () => "/projects/TP/sprints" }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./PmChat", () => ({ PmChat: () => null }));

const PROJECT = {
  _id: "p1",
  key: "TP",
  name: "Test Project",
  pmAvailable: true,
  pm: { enabled: true, lockedByInstance: false },
};

const launcher = () => screen.queryByRole("button", { name: "Open PM chat" });

/** The stacking level an element is actually painted at, read from the class that sets it */
function zOf(el: Element | null | undefined): number {
  const match = /(?:^|\s)z-(\d+)(?:\s|$)/.exec(el?.className?.toString() ?? "");
  return match ? Number(match[1]) : NaN;
}

beforeEach(() => {
  api.get.mockReset();
  api.get.mockResolvedValue(PROJECT);
});

afterEach(cleanup);

describe("where the PM launcher is painted", () => {
  // Compared against the overlay rather than restated as a literal, so drift in either one fails
  it("sits below the layer every dialog is painted on", async () => {
    render(
      <Modal open onClose={() => {}} title="Somebody else's dialog">
        <p>body</p>
      </Modal>
    );
    render(<PmChatWidget />);
    await waitFor(() => expect(launcher()).not.toBeNull());

    const overlay = document.querySelector(".fixed.inset-0");
    expect(zOf(overlay)).toBeGreaterThan(0);
    expect(zOf(launcher())).toBeLessThan(zOf(overlay));
  });

  // The panel is the untested half otherwise: at z-50 it would tie with a dialog and, rendered
  // after the page, paint over it
  it("paints its open panel below that layer too", async () => {
    render(
      <Modal open onClose={() => {}} title="Somebody else's dialog">
        <p>body</p>
      </Modal>
    );
    render(<PmChatWidget />);
    await waitFor(() => expect(launcher()).not.toBeNull());

    fireEvent.click(launcher()!);

    const panel = screen.getByText(/^🤖 PM — /).closest("div")?.parentElement;
    const overlay = document.querySelector(".fixed.inset-0");
    expect(zOf(panel)).toBeLessThan(zOf(overlay));
  });

  // Hiding it was the first fix and it was wrong: the chat's own attachment lightbox is a Modal,
  // so unmounting on any open layer destroyed the panel, its draft and its staged uploads
  it("stays mounted while a dialog is open", async () => {
    render(<PmChatWidget />);
    await waitFor(() => expect(launcher()).not.toBeNull());

    render(
      <Modal open onClose={() => {}} title="Somebody else's dialog">
        <p>body</p>
      </Modal>
    );

    expect(launcher()).not.toBeNull();
  });

  /**
   * BP-591. A bar pinned to the bottom of the page is not something layering can settle — both
   * controls are meant to be pressed — so the bar declares the strip and the launcher steps over
   * it. The two halves of that contract live in different files; this is what keeps them together.
   */
  it("steps up for a bar that declares the bottom strip", async () => {
    render(<PmChatWidget />);
    await waitFor(() => expect(launcher()).not.toBeNull());

    // The whole token, not a substring of it: asserting only the attribute name survives losing
    // the `max-lg:` scope, which is exactly the defect review caught here
    expect(launcher()!.className.split(/\s+/)).toContain(
      "max-lg:[body:has([data-pinned-phone-bar])_&]:bottom-24"
    );
    expect(launcher()!.className.split(/\s+/)).toContain("bottom-6");
    // The save bar's rule carries no width scope: unlike the comment bar it knows when it is
    // open, and the collision it causes is at every width (BP-593)
    expect(launcher()!.className.split(/\s+/)).toContain(
      "[body:has([data-pinned-bottom-bar])_&]:bottom-24"
    );

    // The panel's half of the same rule, and unscoped for the same reason: a `max-lg:` on it
    // alone puts the launcher back on Send above 1024, which no e2e width would see
    fireEvent.click(launcher()!);
    const panel = screen.getByTestId("pm-chat-panel").className.split(/\s+/);
    expect(panel).toContain("[body:has([data-pinned-bottom-bar])_&]:bottom-40");
    expect(panel).toContain(
      "[body:has([data-pinned-bottom-bar])_&]:h-[min(44rem,calc(100vh-12rem))]"
    );
  });

  // The three attributes `Toast` queries for. They are a contract between two files, and the
  // toast suite builds its own fixtures, so renaming one here would leave that suite green while
  // the tray goes back onto Send (BP-597)
  it("declares itself to whatever else wants the corner", async () => {
    render(<PmChatWidget />);
    await waitFor(() => expect(launcher()).not.toBeNull());
    expect(launcher()!.hasAttribute("data-corner-obstacle")).toBe(true);

    fireEvent.click(launcher()!);
    const panel = screen.getByTestId("pm-chat-panel");
    expect(panel.hasAttribute("data-corner-panel")).toBe(true);
    expect(panel.querySelector("[data-corner-panel-header]")).not.toBeNull();
  });

  // The control: the launcher is withheld for its own reasons, and those still hold
  it("is not there at all when the project has no PM", async () => {
    api.get.mockResolvedValue({ ...PROJECT, pm: { enabled: false, lockedByInstance: false } });
    render(<PmChatWidget />);

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(launcher()).toBeNull();
  });
});

/**
 * BP-654. The panel is on screen without being a layer — deliberately, so the board it sits over
 * keeps working — and the cost was that nothing answered for its keyboard: the board's shortcuts
 * fired from the panel's own buttons, and Escape cleared a selection on the board behind it
 * instead of dismissing the chat.
 *
 * The first version of this fix marked the panel and the launcher and stopped there. A reviewer
 * broke it in one move: clicking the panel's header, or a message, lands on nothing focusable, so
 * the focus sat on `body` and every board shortcut was live again — in the very case where the
 * person had just clicked *inside* the chat. Hence `tabIndex={-1}` and the focus on open, which is
 * what actually makes the subtree rule hold.
 */
describe("the chat's own keyboard", () => {
  /** The launcher relabels itself as the panel opens and closes, and the panel's own ✕ borrows the
   *  same name while it is open — so it is the one of the two that is not inside the panel. */
  const fab = () =>
    screen
      .getAllByRole("button", { name: /PM chat$/ })
      .find((el) => !el.closest('[data-testid="pm-chat-panel"]'))!;

  async function open() {
    render(<PmChatWidget />);
    await waitFor(() => expect(launcher()).not.toBeNull());
    fireEvent.click(launcher()!);
    return screen.getByTestId("pm-chat-panel");
  }

  it("claims the panel, and takes the focus into it when it opens", async () => {
    const panel = await open();
    expect(panel.hasAttribute(OWNS_ITS_KEYS)).toBe(true);
    // Programmatically focusable only: it is the click target of last resort inside the panel
    expect(panel.getAttribute("tabindex")).toBe("-1");
    await waitFor(() => expect(document.activeElement).toBe(panel));
  });

  // It is what the focus lands on, so it says what it is rather than having its contents read out
  it("names itself for whoever the focus lands on", async () => {
    const panel = await open();
    expect(panel.getAttribute("role")).toBe("complementary");
    const label = document.getElementById(panel.getAttribute("aria-labelledby")!);
    expect(label?.textContent).toContain("PM");
  });

  /**
   * The launcher is gated rather than simply marked or simply left alone, and both halves matter.
   * The panel has no focus trap — it is not a layer — so Tab walks out of it onto this button,
   * which sits outside the panel: a reviewer measured three Tabs from the open panel landing here,
   * where `n` opened New Task over the chat and Escape cleared the board's selection behind it.
   */
  it("belongs to the chat while the chat is open", async () => {
    await open();
    expect(fab().hasAttribute(OWNS_ITS_KEYS)).toBe(true);
  });

  it("closes the chat on Escape pressed on it, the way the panel does", async () => {
    await open();
    fireEvent.keyDown(fab(), { key: "Escape" });
    expect(screen.queryByTestId("pm-chat-panel")).toBeNull();
  });

  // And gives the keys back once there is no chat to own them
  it("leaves the launcher to the board once the chat is closed", async () => {
    await open();
    fireEvent.keyDown(screen.getByTestId("pm-chat-panel"), { key: "Escape" });
    expect(screen.queryByTestId("pm-chat-panel")).toBeNull();
    expect(fab().hasAttribute(OWNS_ITS_KEYS)).toBe(false);
  });

  it("closes on Escape from inside the panel, and hands the focus back", async () => {
    const panel = await open();
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByTestId("pm-chat-panel")).toBeNull();
    expect(document.activeElement).toBe(fab());
  });

  /**
   * The attachment lightbox inside the chat is a real layer. Escape belongs to it first, and the
   * panel must not close underneath it — that would unmount the draft and the staged uploads, the
   * loss this suite already guards against for a dialog opened elsewhere.
   */
  it("leaves Escape alone while a layer of its own is open", async () => {
    const panel = await open();
    render(
      <Modal open onClose={() => {}} title="An attachment, full size">
        <p>body</p>
      </Modal>
    );

    fireEvent.keyDown(panel, { key: "Escape" });

    expect(screen.queryByTestId("pm-chat-panel")).not.toBeNull();
  });

  /**
   * Escape is the only key the chat answers. What keeps the board's own handler off the others is
   * `ownsItsKeys`, not this component — so they must still travel, and the panel must still be
   * there afterwards. The stop this component does perform is asserted nowhere here on purpose:
   * under RTL the React root is a div below `body`, so a test watching `document` would measure
   * the environment rather than the app, which is how an earlier version of this test lied.
   */
  it("answers no key but Escape, and swallows none of them", async () => {
    const panel = await open();
    const seen: string[] = [];
    const listen = (e: KeyboardEvent) => seen.push(e.key);
    document.addEventListener("keydown", listen);

    for (const key of ["v", "r", "n", "?"]) fireEvent.keyDown(panel, { key });

    document.removeEventListener("keydown", listen);
    expect(seen).toEqual(["v", "r", "n", "?"]);
    expect(screen.queryByTestId("pm-chat-panel")).not.toBeNull();
  });

  it("hands the focus back when the panel's own close button is used", async () => {
    await open();
    const closeButton = screen
      .getAllByRole("button", { name: "Close PM chat" })
      .find((el) => el.closest('[data-testid="pm-chat-panel"]'))!;

    fireEvent.click(closeButton);

    expect(screen.queryByTestId("pm-chat-panel")).toBeNull();
    expect(document.activeElement).toBe(fab());
  });
});
