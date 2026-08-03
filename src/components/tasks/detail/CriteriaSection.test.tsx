// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { CriteriaSection } from "./CriteriaSection";

afterEach(cleanup);

const items = [
  { _id: "c1", text: "First", done: true },
  { _id: "c2", text: "Second", done: false },
];

function renderSection(over: Partial<React.ComponentProps<typeof CriteriaSection>> = {}) {
  const onChange = vi.fn();
  render(<CriteriaSection items={items} onChange={onChange} {...over} />);
  return onChange;
}

function addField() {
  return screen.getByLabelText("Add criterion") as HTMLTextAreaElement;
}

// React maps onBlur to the bubbling focusout, not to blur
function blur(field: HTMLTextAreaElement) {
  field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

function type(field: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )!.set!;
  setter.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CriteriaSection", () => {
  it("reports progress over the whole list", () => {
    renderSection();
    expect(screen.getByText("1/2")).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("2");
  });

  it("leaves the progress out when there is nothing to track", () => {
    renderSection({ items: [] });
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("flips one criterion and leaves the rest alone", async () => {
    const onChange = renderSection();
    await act(async () => screen.getByRole("checkbox", { name: "Second" }).click());
    expect(onChange).toHaveBeenCalledWith([
      { _id: "c1", text: "First", done: true },
      { _id: "c2", text: "Second", done: true },
    ]);
  });

  it("edits a criterion in place", async () => {
    const onChange = renderSection();
    const field = screen.getByLabelText("Criterion 1") as HTMLTextAreaElement;
    await act(async () => type(field, "First, reworded"));
    expect(onChange).toHaveBeenCalledWith([
      { _id: "c1", text: "First, reworded", done: true },
      { _id: "c2", text: "Second", done: false },
    ]);
  });

  // A criterion runs to two lines in the design; an input would scroll the tail
  // out of sight instead of wrapping
  it("gives each criterion a field that wraps", () => {
    renderSection();
    expect(screen.getByLabelText("Criterion 1").tagName).toBe("TEXTAREA");
    expect(addField().tagName).toBe("TEXTAREA");
  });

  it("removes a criterion", async () => {
    const onChange = renderSection();
    await act(async () =>
      screen.getByRole("button", { name: "Remove criterion 1" }).click()
    );
    expect(onChange).toHaveBeenCalledWith([{ _id: "c2", text: "Second", done: false }]);
  });

  it("appends on Enter, without a newline in the criterion", async () => {
    const onChange = renderSection();
    const field = addField();
    await act(async () => type(field, "Third"));
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith([...items, { text: "Third", done: false }]);
  });

  // Typing something and clicking away should not silently discard it
  it("appends on blur too", async () => {
    const onChange = renderSection();
    const field = addField();
    await act(async () => type(field, "Fourth"));
    await act(async () => blur(field));
    expect(onChange).toHaveBeenCalledWith([...items, { text: "Fourth", done: false }]);
  });

  it("ignores an empty add", async () => {
    const onChange = renderSection();
    const field = addField();
    await act(async () => type(field, "   "));
    await act(async () => blur(field));
    expect(onChange).not.toHaveBeenCalled();
  });
});
