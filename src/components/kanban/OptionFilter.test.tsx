// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { OptionFilter } from "./OptionFilter";
import { ApiCustomField } from "@/types";

const labels = {
  _id: "fl",
  name: "Labels",
  fieldType: "multiselect",
  options: [
    { id: "a", value: "Alpha", color: "#111111", order: 0 },
    { id: "b", value: "Beta", color: "#222222", order: 1 },
    { id: "c", value: "Gamma", color: "#333333", order: 2 },
  ],
} as unknown as ApiCustomField;

afterEach(cleanup);

describe("OptionFilter", () => {
  it("shows every option as a toggle and says which are picked", () => {
    render(<OptionFilter field={labels} filter={{ values: ["b"] }} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Beta" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("adds a pick and removes one, keeping the mode", () => {
    const onChange = vi.fn();
    render(<OptionFilter field={labels} filter={{ values: ["a"], mode: "all" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(onChange).toHaveBeenLastCalledWith({ value: "", values: ["a", "b"], mode: "all" });
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(onChange).toHaveBeenLastCalledWith({ value: "", values: [], mode: "all" });
  });

  it("reads the single value an older filter stored as a pick", () => {
    const onChange = vi.fn();
    render(<OptionFilter field={labels} filter={{ value: "c" }} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Gamma" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(onChange).toHaveBeenLastCalledWith({ value: "", values: ["c", "a"], mode: "any" });
  });

  it("offers any/all only once two are picked, and says which is chosen", () => {
    const onChange = vi.fn();
    const { rerender } = render(<OptionFilter field={labels} filter={{ values: ["a"] }} onChange={onChange} />);
    expect(screen.queryByRole("button", { name: "All of them" })).toBeNull();

    rerender(<OptionFilter field={labels} filter={{ values: ["a", "b"] }} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Any of them" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "All of them" }));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "all" });

    rerender(<OptionFilter field={labels} filter={{ values: ["a", "b"], mode: "all" }} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "All of them" }).getAttribute("aria-pressed")).toBe("true");
  });
});
