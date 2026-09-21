// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskForm } from "./TaskForm";

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() };
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockResolvedValue([]);
  api.post.mockResolvedValue({ _id: "t1", taskNumber: 1 });
});
afterEach(cleanup);

function mount() {
  const onSaved = vi.fn();
  render(<TaskForm projectId="p1" onSaved={onSaved} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "A task" } });
  return { onSaved, input: screen.getByPlaceholderText("Add checklist item...") };
}

describe("the checklist box", () => {
  it("adds what was typed on Enter, and clears itself", () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: "tag pushed" } });
    const enter = fireEvent.keyDown(input, { key: "Enter" });

    expect(enter).toBe(false);
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByDisplayValue("tag pushed")).toBeTruthy();
  });

  it("keeps Enter to itself when it is empty, so the task is not submitted half-written", () => {
    const { input } = mount();
    const enter = fireEvent.keyDown(input, { key: "Enter" });

    expect(enter, "Enter on an empty checklist box was left to submit the form").toBe(false);
  });

  it("leaves an Enter that confirms an IME candidate to the IME, and adds nothing", () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: "かくにん" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect((input as HTMLInputElement).value).toBe("かくにん");
    expect(screen.getAllByDisplayValue("かくにん")).toEqual([input]);
  });
});
