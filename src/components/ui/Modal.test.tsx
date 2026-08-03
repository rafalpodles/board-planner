// @vitest-environment happy-dom
import { useRef } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
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

function blurEverything() {
  act(() => (document.activeElement as HTMLElement | null)?.blur());
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

  it("still carries a name while the title is being fetched", () => {
    render(
      <Modal open onClose={() => {}} title="" size="xl">
        <p>Loading</p>
      </Modal>
    );
    expect(screen.getByRole("dialog", { name: /\S/ })).toBeTruthy();
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
});

describe("Modal focus return", () => {
  it("returns focus to the element that opened it", () => {
    const { rerender } = render(<Trigger open={false} />);
    const trigger = screen.getByRole("button", { name: "Open sprint" });
    trigger.focus();

    rerender(<Trigger open />);
    expect(document.activeElement).not.toBe(trigger);

    rerender(<Trigger open={false} />);
    expect(document.activeElement).toBe(trigger);
  });

  it("does not dump focus on the document body when nothing opened it", () => {
    const bodyFocus = vi.spyOn(document.body, "focus");
    const { rerender } = render(<Trigger open={false} />);
    blurEverything();

    rerender(<Trigger open />);
    rerender(<Trigger open={false} />);

    expect(bodyFocus).not.toHaveBeenCalled();
    bodyFocus.mockRestore();
  });

  it("hands focus to returnFocusTo when the dialog was opened by a shortcut", () => {
    function Shortcut({ open }: { open: boolean }) {
      const newTask = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={newTask}>New task</button>
          <Modal open={open} onClose={() => {}} title="New task" returnFocusTo={newTask}>
            <button>Create</button>
          </Modal>
        </>
      );
    }
    const { rerender } = render(<Shortcut open={false} />);
    blurEverything();

    rerender(<Shortcut open />);
    rerender(<Shortcut open={false} />);

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New task" }));
  });

  it("prefers the real trigger over returnFocusTo when there was one", () => {
    function Both({ open }: { open: boolean }) {
      const fallback = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={fallback}>Fallback</button>
          <button>Clicked me</button>
          <Modal open={open} onClose={() => {}} title="New task" returnFocusTo={fallback}>
            <button>Create</button>
          </Modal>
        </>
      );
    }
    const { rerender } = render(<Both open={false} />);
    const clicked = screen.getByRole("button", { name: "Clicked me" });
    clicked.focus();

    rerender(<Both open />);
    rerender(<Both open={false} />);

    expect(document.activeElement).toBe(clicked);
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
    blurEverything();

    press("Tab");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /close/i }));
  });
});

// The task detail keeps both tab panels mounted and hides the inactive one, so the
// trap has to end at the last control the user can actually see
describe("Modal focus trap, against controls that are not on screen", () => {
  function renderTaskDetailShape() {
    return render(
      <Modal open onClose={() => {}} title="CP-185" size="xl">
        <div role="tabpanel">
          <textarea aria-label="Comment" />
        </div>
        <div role="tabpanel" hidden>
          <button>Show all 12 entries</button>
        </div>
        <div style={{ display: "none" }}>
          <button>Collapsed action</button>
        </div>
      </Modal>
    );
  }

  it("wraps Tab from the last visible control instead of letting focus escape", () => {
    renderTaskDetailShape();
    screen.getByRole("textbox", { name: "Comment" }).focus();

    const event = press("Tab");
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /close/i }));
  });

  it("sends Shift+Tab to the last visible control, never into a hidden panel", () => {
    renderTaskDetailShape();
    screen.getByRole("button", { name: /close/i }).focus();

    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment" }));
  });
});

describe("Modal focus trap, around a <details>", () => {
  function renderWithDetails() {
    return render(
      <Modal open onClose={() => {}} title="Import Tasks">
        <textarea aria-label="Markdown" />
        <details>
          <summary>Format instructions</summary>
          <a href="/docs/format">Full format reference</a>
        </details>
      </Modal>
    );
  }

  it("treats the summary as the tabbable it is", () => {
    renderWithDetails();
    screen.getByText("Format instructions").focus();

    const event = press("Tab");
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /close/i }));
  });

  it("skips the links a collapsed details is hiding", () => {
    renderWithDetails();
    screen.getByRole("button", { name: /close/i }).focus();

    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("Format instructions"));
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

describe("Stacked modals", () => {
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

  it("ignores a scrim click on the dialog underneath", () => {
    const onOuterClose = vi.fn();
    const { container } = render(
      <Nested innerOpen onInnerClose={() => {}} onOuterClose={onOuterClose} />
    );

    act(() => (container.firstElementChild as HTMLElement).click());
    expect(onOuterClose).not.toHaveBeenCalled();
  });

  it("wraps Tab inside the innermost dialog, never back out to the outer one", () => {
    render(<Nested innerOpen onInnerClose={() => {}} onOuterClose={() => {}} />);
    const inner = screen.getByRole("dialog", { name: "New child" });

    screen.getByRole("button", { name: "Create" }).focus();
    const event = press("Tab");

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(
      within(inner).getByRole("button", { name: /close/i })
    );
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

  // Two dialogs side by side share z-50, so the one further down the DOM is the one
  // on screen — whichever order they happened to be opened in
  it("gives Escape to the sibling painted in front, not the one opened last", () => {
    const onFirstClose = vi.fn();
    const onSecondClose = vi.fn();
    function Siblings({ firstOpen }: { firstOpen: boolean }) {
      return (
        <>
          <Modal open={firstOpen} onClose={onFirstClose} title="Behind">
            <button>A</button>
          </Modal>
          <Modal open onClose={onSecondClose} title="In front">
            <button>B</button>
          </Modal>
        </>
      );
    }

    const { rerender } = render(<Siblings firstOpen={false} />);
    rerender(<Siblings firstOpen />);

    press("Escape");
    expect(onSecondClose).toHaveBeenCalledTimes(1);
    expect(onFirstClose).not.toHaveBeenCalled();
  });
});

// The task detail draws its own top bar — breadcrumb, status, close — so the
// modal's header would be a second one sitting above it
describe("Modal, bare", () => {
  it("drops its header but stays a labelled dialog", () => {
    render(
      <Modal open onClose={() => {}} title="CP-225" size="xl" bare>
        <div>detail</div>
      </Modal>
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("CP-225");
    expect(dialog.getAttribute("aria-labelledby")).toBeNull();
    expect(screen.queryByRole("heading", { name: "CP-225" })).toBeNull();
    expect(screen.queryByRole("button", { name: /close dialog/i })).toBeNull();
    expect(screen.getByText("detail")).toBeTruthy();
  });

  it("still labels itself when the title has not arrived yet", () => {
    render(
      <Modal open onClose={() => {}} title="" size="xl" bare>
        <div>detail</div>
      </Modal>
    );
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Dialog");
  });

  it("keeps the header for every other caller", () => {
    render(
      <Modal open onClose={() => {}} title="New Task">
        <div>form</div>
      </Modal>
    );
    expect(screen.getByRole("heading", { name: "New Task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /close dialog/i })).toBeTruthy();
  });
});
