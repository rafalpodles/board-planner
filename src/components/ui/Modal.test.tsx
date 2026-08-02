// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { Modal } from "./Modal";

afterEach(cleanup);

function renderModal(over: Partial<React.ComponentProps<typeof Modal>> = {}) {
  return render(
    <Modal open onClose={() => {}} title="Edit Sprint" {...over}>
      <input aria-label="Name" />
      <button>Save</button>
    </Modal>
  );
}

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

function Trigger({ open }: { open: boolean }) {
  return (
    <>
      <button>Open sprint</button>
      <Modal open={open} onClose={() => {}} title="Edit Sprint">
        <button>Save</button>
      </Modal>
    </>
  );
}

describe("Modal, as a dialog", () => {
  it("announces itself as a modal dialog named by its title", () => {
    renderModal();
    const dialog = screen.getByRole("dialog", { name: "Edit Sprint" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("names the close button for anyone who cannot see the glyph", () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    const close = screen.getByRole("button", { name: /close/i });
    act(() => close.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog when it opens", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("returns focus to the element that opened it", () => {
    const { rerender } = render(<Trigger open={false} />);
    const trigger = screen.getByRole("button", { name: "Open sprint" });
    trigger.focus();

    rerender(<Trigger open />);
    expect(document.activeElement).not.toBe(trigger);

    rerender(<Trigger open={false} />);
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Modal focus trap", () => {
  it("wraps Tab from the last control back to the first", () => {
    renderModal();
    const save = screen.getByRole("button", { name: "Save" });
    save.focus();

    const event = press("Tab");
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /close/i }));
  });

  it("wraps Shift+Tab from the first control back to the last", () => {
    renderModal();
    screen.getByRole("button", { name: /close/i }).focus();

    const event = press("Tab", { shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
  });

  it("keeps Shift+Tab off the dialog itself from escaping to the page behind", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    dialog.focus();

    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
  });

  it("pulls focus back in when it has drifted outside", () => {
    renderModal();
    act(() => (document.activeElement as HTMLElement)?.blur());

    press("Tab");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /close/i }));
  });
});

describe("Modal chrome", () => {
  it("keeps the title row out of the scrolling body", () => {
    const { container } = render(
      <Modal open onClose={() => {}} title="Edit Sprint">
        <p>Body</p>
      </Modal>
    );
    const scroller = container.querySelector(".overflow-y-auto")!;
    expect(scroller.contains(screen.getByText("Body"))).toBe(true);
    expect(scroller.contains(screen.getByRole("heading", { name: "Edit Sprint" }))).toBe(
      false
    );
    expect(scroller.contains(screen.getByRole("button", { name: /close/i }))).toBe(false);
  });

  it("no longer scrolls the whole panel", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).not.toContain("overflow-y-auto");
    expect(dialog.className).toContain("flex-col");
    expect(dialog.className).toContain("max-h-[90vh]");
  });

  it("keeps every size as wide as it was", () => {
    for (const [size, width] of [
      ["sm", "sm:max-w-md"],
      ["md", "sm:max-w-lg"],
      ["lg", "sm:max-w-2xl"],
      ["xl", "sm:max-w-6xl"],
    ] as const) {
      renderModal({ size });
      expect(screen.getByRole("dialog").className).toContain(width);
      cleanup();
    }
  });
});

describe("Modal dismissal, still intact", () => {
  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a scrim click but not on a click inside", () => {
    const onClose = vi.fn();
    const { container } = renderModal({ onClose });
    act(() => (container.firstElementChild as HTMLElement).click());
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => screen.getByRole("dialog").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll while open and releases it on close", () => {
    const { rerender } = render(<Trigger open />);
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<Trigger open={false} />);
    expect(document.body.style.overflow).toBe("");
  });
});

describe("Nested modals", () => {
  function Nested({
    innerOpen,
    onInnerClose,
    onOuterClose,
  }: {
    innerOpen: boolean;
    onInnerClose: () => void;
    onOuterClose: () => void;
  }) {
    return (
      <Modal open onClose={onOuterClose} title="Task">
        <button>Add child</button>
        <Modal open={innerOpen} onClose={onInnerClose} title="New child">
          <button>Create</button>
        </Modal>
      </Modal>
    );
  }

  it("lets only the innermost dialog answer Escape", () => {
    const onInnerClose = vi.fn();
    const onOuterClose = vi.fn();
    render(
      <Nested innerOpen onInnerClose={onInnerClose} onOuterClose={onOuterClose} />
    );

    press("Escape");
    expect(onInnerClose).toHaveBeenCalledTimes(1);
    expect(onOuterClose).not.toHaveBeenCalled();
  });

  it("traps focus in the innermost dialog", () => {
    render(<Nested innerOpen onInnerClose={() => {}} onOuterClose={() => {}} />);
    const inner = screen.getByRole("dialog", { name: "New child" });

    screen.getByRole("button", { name: "Create" }).focus();
    press("Tab");
    expect(inner.contains(document.activeElement)).toBe(true);
  });

  it("keeps body scroll locked while the outer dialog stays open", () => {
    const { rerender } = render(
      <Nested innerOpen onInnerClose={() => {}} onOuterClose={() => {}} />
    );
    rerender(
      <Nested innerOpen={false} onInnerClose={() => {}} onOuterClose={() => {}} />
    );
    expect(document.body.style.overflow).toBe("hidden");
  });
});
