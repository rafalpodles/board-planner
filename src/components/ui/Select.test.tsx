// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Select } from "./Select";

/**
 * BP-450. The `<label>` carried no `htmlFor` and did not wrap the control, so every select in the
 * app had no accessible name — `Input` beside it had minted an id with `useId()` since it was
 * written. The e2e sweeps the real pages; this holds the two contracts a page cannot show,
 * because no caller passes an `id` today and nothing would notice if that stopped working.
 */

const OPTIONS = [{ value: "a", label: "Apples" }];

afterEach(cleanup);

describe("Select", () => {
  it("associates its label with the control", () => {
    render(<Select label="How often" options={OPTIONS} />);

    // Resolved through the label, which is what an assistive technology does
    expect(screen.getByLabelText("How often").tagName).toBe("SELECT");
  });

  it("honours a caller-supplied id rather than overwriting it", () => {
    render(<Select label="How often" id="chosen-by-the-caller" options={OPTIONS} />);

    const control = screen.getByLabelText("How often");
    expect(control.id).toBe("chosen-by-the-caller");
    expect(document.querySelector('label[for="chosen-by-the-caller"]')).not.toBeNull();
  });

  it("gives two selects on one page distinct ids", () => {
    render(
      <>
        <Select label="First" options={OPTIONS} />
        <Select label="Second" options={OPTIONS} />
      </>
    );

    expect(screen.getByLabelText("First").id).not.toBe(screen.getByLabelText("Second").id);
    expect(screen.getByLabelText("First").id).not.toBe("");
  });

  /**
   * The marker sits inside the `<label>` and carries `title="Unsaved"`, which the name computation
   * folds in — measured in a real browser, where the name came back as "How often Unsaved". It is
   * decorative, so it is hidden from the tree and keeps the tooltip for a mouse.
   */
  it("keeps the unsaved marker out of the name", () => {
    const { container } = render(<Select label="How often" dirty options={OPTIONS} />);

    const marker = container.querySelector('[title="Unsaved"]');
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute("aria-hidden")).toBe("true");
  });

  // The control: no label, no association — and no empty <label> left behind either
  it("renders no label element when it was given none", () => {
    const { container } = render(<Select options={OPTIONS} />);

    expect(container.querySelector("label")).toBeNull();
  });
});
