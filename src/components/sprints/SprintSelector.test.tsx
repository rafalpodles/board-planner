// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
import { SprintSelector } from "./SprintSelector";
import { ApiSprint } from "@/types";

function sprint(over: Partial<ApiSprint> & { _id: string }): ApiSprint {
  return {
    name: over._id,
    startDate: "2026-01-01T00:00:00Z",
    endDate: "2026-01-15T00:00:00Z",
    goal: "",
    status: "completed",
    taskCount: 0,
    doneCount: 0,
    ...over,
  } as ApiSprint;
}

// Five completed sprints, so three are recent and two are older
const many: ApiSprint[] = [
  sprint({ _id: "a", name: "Sprint 1", endDate: "2026-01-15T00:00:00Z" }),
  sprint({ _id: "b", name: "Sprint 2", endDate: "2026-02-15T00:00:00Z" }),
  sprint({ _id: "c", name: "Sprint 3", endDate: "2026-03-15T00:00:00Z" }),
  sprint({ _id: "d", name: "Sprint 4", endDate: "2026-04-15T00:00:00Z" }),
  sprint({ _id: "e", name: "Sprint 5", endDate: "2026-05-15T00:00:00Z" }),
  sprint({ _id: "f", name: "Sprint 6", status: "active", taskCount: 8, doneCount: 4 }),
];

function narrowViewport() {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) =>
      ({
        media,
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList
  );
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SprintSelector", () => {
  it("keeps completed sprints past the third behind a toggle", () => {
    render(<SprintSelector sprints={many} selectedId="f" onSelect={() => {}} />);

    // Sorted by end date descending, so 5, 4 and 3 are the recent three
    expect(screen.getByRole("button", { name: /Sprint 5/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sprint 3/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sprint 2/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sprint 1/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Show 2 older" })).toBeTruthy();
  });

  it("reveals them when the toggle is used", async () => {
    render(<SprintSelector sprints={many} selectedId="f" onSelect={() => {}} />);

    await click(screen.getByRole("button", { name: "Show 2 older" }));

    expect(screen.getByRole("button", { name: /Sprint 2/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sprint 1/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show 2 older" })).toBeNull();
  });

  it("reports the sprint that was picked", async () => {
    const onSelect = vi.fn();
    render(<SprintSelector sprints={many} selectedId="f" onSelect={onSelect} />);

    await click(screen.getByRole("button", { name: /Sprint 5/ }));

    expect(onSelect).toHaveBeenCalledWith("e");
  });

  describe("below lg", () => {
    it("offers a placeholder rather than a name it has not selected", () => {
      narrowViewport();
      render(<SprintSelector sprints={many} selectedId={null} onSelect={() => {}} />);

      const select = screen.getByRole("combobox", { name: "Sprint" }) as HTMLSelectElement;
      expect(select.value).toBe("");
      expect(within(select).getByRole("option", { name: "Choose a sprint" })).toBeTruthy();
    });

    it("shows the selected sprint and drops the placeholder once there is one", () => {
      narrowViewport();
      render(<SprintSelector sprints={many} selectedId="f" onSelect={() => {}} />);

      const select = screen.getByRole("combobox", { name: "Sprint" }) as HTMLSelectElement;
      expect(select.value).toBe("f");
      expect(within(select).queryByRole("option", { name: "Choose a sprint" })).toBeNull();
      expect(within(select).getByRole("option", { name: "Sprint 6 · 4/8" })).toBeTruthy();
      expect(screen.queryByRole("navigation", { name: "Sprint list" })).toBeNull();
    });
  });
});
