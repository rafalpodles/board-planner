// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Input } from "./Input";
import { Textarea } from "./Textarea";

afterEach(cleanup);

describe("Input label association", () => {
  it("names the field by its label", () => {
    render(<Input label="Email" />);
    expect(screen.getByLabelText("Email").tagName).toBe("INPUT");
  });

  it("honours a caller-supplied id instead of generating one", () => {
    render(<Input label="Email" id="chosen-id" />);
    expect(screen.getByLabelText("Email").getAttribute("id")).toBe("chosen-id");
  });

  it("keeps two instances apart", () => {
    render(
      <>
        <Input label="First" />
        <Input label="Second" />
      </>
    );
    const first = screen.getByLabelText("First");
    const second = screen.getByLabelText("Second");
    expect(first.getAttribute("id")).not.toBe(second.getAttribute("id"));
  });

  it("renders no stray label when none is given", () => {
    const { container } = render(<Input placeholder="Search" />);
    expect(container.querySelector("label")).toBeNull();
  });
});

describe("Textarea label association", () => {
  it("names the field by its label", () => {
    render(<Textarea label="Description" />);
    expect(screen.getByLabelText("Description").tagName).toBe("TEXTAREA");
  });
});
