// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { TriagePanel } from "./TriagePanel";
import type { ApiTaskTriage } from "@/types";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));

const OPEN: ApiTaskTriage = {
  state: "ready",
  mode: "suggest",
  suggestions: [
    { _id: "a1", field: "assignee", value: "member", reason: "", outcome: "open" },
    { _id: "c1", field: "category", value: "bug", reason: "", outcome: "open" },
  ],
};

const withOutcome = (id: string, outcome: "applied" | "dismissed"): ApiTaskTriage => ({
  ...OPEN,
  suggestions: OPEN.suggestions.map((s) => (s._id === id ? { ...s, outcome } : s)),
});

function panel(props: Partial<React.ComponentProps<typeof TriagePanel>> = {}) {
  const handlers = { onTriage: vi.fn(), onChanged: vi.fn() };
  render(<TriagePanel projectId="TP" taskId="t1" triage={OPEN} customFields={[]} {...handlers} {...props} />);
  return handlers;
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
});

afterEach(cleanup);

describe("what the panel tells the task it sits in", () => {
  it("hands over the answer to a dismissal, which asks for no reload of its own", async () => {
    const answer = withOutcome("c1", "dismissed");
    api.post.mockResolvedValue({ triage: answer });
    const { onTriage, onChanged } = panel();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Category: bug" }));

    await waitFor(() => expect(onTriage).toHaveBeenCalledWith(answer));
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("bug")).toBeNull();
  });

  it("hands over the answer to an apply too, and asks the task to reload", async () => {
    const answer = withOutcome("a1", "applied");
    api.post.mockResolvedValue({ triage: answer });
    const { onTriage, onChanged } = panel();

    fireEvent.click(screen.getByRole("button", { name: "Apply Assignee: member" }));

    await waitFor(() => expect(onTriage).toHaveBeenCalledWith(answer));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the write was refused", async () => {
    api.post.mockRejectedValue(new Error("That suggestion was dismissed already"));
    const { onTriage, onChanged } = panel();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Category: bug" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That suggestion was dismissed already");
    expect(onTriage).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
