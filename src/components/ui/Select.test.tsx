// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Select } from "./Select";

const OPTIONS = [{ value: "a", label: "Apples" }];

afterEach(cleanup);

describe("Select", () => {
  it("associates its label with the control", () => {
    render(<Select label="How often" options={OPTIONS} />);

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

  it("keeps the unsaved marker out of the name", () => {
    const { container } = render(<Select label="How often" dirty options={OPTIONS} />);

    const marker = container.querySelector('[title="Unsaved"]');
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders no label element when it was given none", () => {
    const { container } = render(<Select options={OPTIONS} />);

    expect(container.querySelector("label")).toBeNull();
  });
});
