// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { Modal } from "@/components/ui/Modal";
import { PmChatWidget } from "./PmChatWidget";

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

  // The control: the launcher is withheld for its own reasons, and those still hold
  it("is not there at all when the project has no PM", async () => {
    api.get.mockResolvedValue({ ...PROJECT, pm: { enabled: false, lockedByInstance: false } });
    render(<PmChatWidget />);

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(launcher()).toBeNull();
  });
});
