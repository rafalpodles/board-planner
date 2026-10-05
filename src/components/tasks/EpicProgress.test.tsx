// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { EpicProgress } from "./EpicProgress";

afterEach(cleanup);

describe("EpicProgress", () => {
  it("reads out as '2 of 5 done' rather than a bare number against a maximum", () => {
    render(<EpicProgress progress={{ done: 2, total: 5 }} />);

    const bar = screen.getByRole("progressbar", { name: "Children done" });
    expect(bar.getAttribute("aria-valuetext")).toBe("2 of 5 done");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
  });
});
