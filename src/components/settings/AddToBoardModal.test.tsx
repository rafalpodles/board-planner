// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const { api, toast } = vi.hoisted(() => ({
  api: { put: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({
    projects: [
      { _id: "p1", key: "TP", name: "Test Project" },
      { _id: "p2", key: "ORB", name: "Orbit" },
    ],
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { AddToBoardModal } = await import("./AddToBoardModal");

const GRACE = { _id: "u3", fullName: "Grace Hopper" };
const ADA = { _id: "u4", fullName: "Ada Lovelace" };

function choose(label: string, value: string) {
  const select = screen.getByLabelText(label) as HTMLSelectElement;
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("AddToBoardModal", () => {
  it("hands both buttons back after a refusal, so the admin can try again or leave", async () => {
    api.put.mockRejectedValue(new Error("Forbidden"));
    render(<AddToBoardModal person={GRACE} onClose={vi.fn()} />);

    await act(async () => button("Add to board").click());

    expect(await screen.findByText("Forbidden")).toBeTruthy();
    expect(button("Add to board").disabled).toBe(false);
    expect(button("Cancel").disabled).toBe(false);
  });

  it("starts afresh for the next person: first board, member, no error", async () => {
    api.put.mockRejectedValue(new Error("Forbidden"));
    const { rerender } = render(<AddToBoardModal person={GRACE} onClose={vi.fn()} />);
    choose("Board", "p2");
    choose("Role", "owner");
    await act(async () => button("Add to board").click());
    expect(await screen.findByText("Forbidden")).toBeTruthy();

    rerender(<AddToBoardModal person={null} onClose={vi.fn()} />);
    rerender(<AddToBoardModal person={ADA} onClose={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Add Ada Lovelace to a board" })).toBeTruthy();
    expect((screen.getByLabelText("Board") as HTMLSelectElement).value).toBe("p1");
    expect((screen.getByLabelText("Role") as HTMLSelectElement).value).toBe("member");
    expect(screen.queryByText("Forbidden")).toBeNull();
  });
});
