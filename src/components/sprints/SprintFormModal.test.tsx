// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SprintFormModal } from "./SprintFormModal";

afterEach(cleanup);

// BP-1028. Three native date fields in a phone's dialog are about a hundred pixels each, and a date
// that reads "/12/2030" cannot be checked. The row stacks below sm and is three columns from sm up.
describe("SprintFormModal", () => {
  const props = { sprints: [], editing: null, saving: false, onSubmit: vi.fn(), onClose: vi.fn() };

  function dateRow() {
    const start = screen.getByLabelText("Start Date");
    return start.closest(".grid") as HTMLElement;
  }

  it("stacks the start date, the duration and the end date on a phone, in that order", () => {
    render(<SprintFormModal {...props} />);

    const row = dateRow();
    expect(row.className).toContain("grid-cols-1");
    const labels = Array.from(row.querySelectorAll("label")).map((l) => l.textContent);
    expect(labels).toEqual(["Start Date", "Duration", "End Date"]);
  });

  it("puts the three side by side from sm up", () => {
    render(<SprintFormModal {...props} />);

    expect(dateRow().className).toContain("sm:grid-cols-3");
    expect(dateRow().className).not.toMatch(/(^|\s)grid-cols-3/);
  });

  it("is the same row when editing", () => {
    render(
      <SprintFormModal
        {...props}
        editing={{
          _id: "s1",
          name: "Sprint 1",
          startDate: "2030-12-01T00:00:00.000Z",
          endDate: "2030-12-15T00:00:00.000Z",
          goal: "",
          status: "planned",
        } as never}
      />
    );

    expect(dateRow().className).toContain("sm:grid-cols-3");
    expect((screen.getByLabelText("Start Date") as HTMLInputElement).value).toBe("2030-12-01");
  });
});
