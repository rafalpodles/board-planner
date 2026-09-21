// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const { api, toast, boards } = vi.hoisted(() => ({
  api: { put: vi.fn() },
  toast: vi.fn(),
  boards: {
    projects: [] as { _id: string; key: string; name: string }[],
    loadFailed: false,
    retrying: false,
    reload: vi.fn(),
  },
}));

const TWO_BOARDS = [
  { _id: "p1", key: "TP", name: "Test Project" },
  { _id: "p2", key: "ORB", name: "Orbit" },
];

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/use-projects", () => ({ useProjects: () => boards }));
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

beforeEach(() => {
  vi.clearAllMocks();
  boards.projects = TWO_BOARDS;
  boards.loadFailed = false;
  boards.retrying = false;
});
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

  it("says the boards could not be read, with a retry, rather than that there are none", () => {
    boards.projects = [];
    boards.loadFailed = true;
    render(<AddToBoardModal person={GRACE} onClose={vi.fn()} />);

    expect(screen.getByRole("alert").textContent).toContain("The boards could not be loaded.");
    expect(screen.queryByText(/There is no board yet/)).toBeNull();
    act(() => button("Retry").click());
    expect(boards.reload).toHaveBeenCalled();
  });

  it("still offers the first board when there really is none", () => {
    boards.projects = [];
    render(<AddToBoardModal person={GRACE} onClose={vi.fn()} />);

    expect(screen.getByText(/There is no board yet/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("picks the board once the list arrives after the dialog opened", async () => {
    api.put.mockResolvedValue({ ok: true });
    boards.projects = [];
    const { rerender } = render(<AddToBoardModal person={GRACE} onClose={vi.fn()} />);

    boards.projects = [{ _id: "p9", key: "ONE", name: "Only board" }];
    rerender(<AddToBoardModal person={GRACE} onClose={vi.fn()} />);

    expect((screen.getByLabelText("Board") as HTMLSelectElement).value).toBe("p9");
    expect(button("Add to board").disabled).toBe(false);
    await act(async () => button("Add to board").click());
    expect(api.put).toHaveBeenCalledWith("/api/projects/p9/members", {
      userId: "u3",
      relation: "member",
    });
  });
});
