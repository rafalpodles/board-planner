// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { registerLayer } from "@/lib/focus-trap";
import { PmChatWidget } from "./PmChatWidget";

/**
 * BP-589. At phone width a dialog is a bottom sheet, and this launcher is painted at the same
 * z-50 over its action row: on a right-aligned footer it covered the primary button's own corner,
 * so a finger there opened the PM chat instead of pressing the button under it.
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

beforeEach(() => {
  api.get.mockReset();
  api.get.mockResolvedValue(PROJECT);
});

afterEach(cleanup);

describe("the PM launcher and an open dialog", () => {
  it("is there when nothing is layered over the page", async () => {
    render(<PmChatWidget />);

    await waitFor(() => expect(launcher()).not.toBeNull());
  });

  it("stands aside while a dialog is open, and comes back when it closes", async () => {
    render(<PmChatWidget />);
    await waitFor(() => expect(launcher()).not.toBeNull());

    const dialog = document.createElement("div");
    document.body.appendChild(dialog);
    let close = () => {};
    act(() => {
      close = registerLayer(dialog);
    });

    expect(launcher()).toBeNull();

    act(() => close());

    await waitFor(() => expect(launcher()).not.toBeNull());
    dialog.remove();
  });

  // Two layers deep — a dialog opened from inside the drawer — must not uncover it on the first close
  it("stays away until the last layer has gone", async () => {
    render(<PmChatWidget />);
    await waitFor(() => expect(launcher()).not.toBeNull());

    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);
    let closeFirst = () => {};
    let closeSecond = () => {};
    act(() => {
      closeFirst = registerLayer(first);
      closeSecond = registerLayer(second);
    });

    act(() => closeSecond());
    expect(launcher()).toBeNull();

    act(() => closeFirst());
    await waitFor(() => expect(launcher()).not.toBeNull());
    first.remove();
    second.remove();
  });

  // The control: withholding it has to be about the layer, not about the widget's own gate
  it("is not there at all when the project has no PM", async () => {
    api.get.mockResolvedValue({ ...PROJECT, pm: { enabled: false, lockedByInstance: false } });
    render(<PmChatWidget />);

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(launcher()).toBeNull();
  });
});
