// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LIST_REFRESH_FAILED } from "@/lib/list-refresh";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import UsersPage from "./page";

const { api, auth, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  auth: { user: { _id: "u1", username: "owner" }, isAdmin: true, isLoading: false },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({
    projects: [
      { _id: "p1", key: "TP", name: "Test Project" },
      { _id: "p2", key: "ORB", name: "Orbit" },
    ],
    isLoading: false,
  }),
}));

const OTHER = { _id: "u2", username: "ada", fullName: "Ada", role: "member", email: "" };

beforeEach(() => {
  vi.clearAllMocks();
  toast.mockClear();
  api.get.mockImplementation((path: string) =>
    path === "/api/users" ? Promise.resolve([OTHER]) : Promise.resolve({ configured: false })
  );
});
afterEach(cleanup);

function escape() {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
  });
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * BP-565. The dialogs refuse to close while their write is in flight, which makes the flag they
 * refuse on part of the dialog's lifetime: it was still set through the list refetch that follows
 * a successful save, so the *next* dialog opened during that fetch was born with Escape, the scrim,
 * the × and every button refused — for a request that was not its own.
 */
describe("the users page, after a save that is followed by a refetch", () => {
  it("opens the next dialog free, while the list is still being fetched", async () => {
    let releaseList: (value: unknown) => void = () => {};
    api.put.mockResolvedValue({});

    render(<UsersPage />);
    await screen.findByText("Ada");

    act(() => screen.getByText("Ada").click());
    await screen.findByRole("dialog", { name: /Edit Ada/ });

    // The refetch that follows the save, held open
    api.get.mockImplementation((path: string) =>
      path === "/api/users"
        ? new Promise((resolve) => (releaseList = resolve))
        : Promise.resolve({ configured: false })
    );

    await act(async () => {
      screen.getByRole("button", { name: "Save" }).click();
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit Ada/ })).toBeNull());

    // Still fetching. The dialog opened now has no request of its own, so nothing about it may
    // refuse: the save it would be refusing for is over.
    act(() => screen.getByText("Ada").click());
    const reopened = await screen.findByRole("dialog", { name: /Edit Ada/ });
    expect(reopened.getAttribute("aria-busy")).toBeNull();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      false
    );
    escape();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit Ada/ })).toBeNull());

    await act(async () => {
      releaseList([OTHER]);
    });
  });

  it("does the same after a create, which is a different flag on a different dialog", async () => {
    let releaseList: (value: unknown) => void = () => {};
    api.post.mockResolvedValue({ _id: "u3", fullName: "Grace Hopper" });

    render(<UsersPage />);
    await screen.findByText("Ada");

    act(() => screen.getByRole("button", { name: /new user/i }).click());
    type(screen.getByLabelText("Username") as HTMLInputElement, "grace");
    type(screen.getByLabelText("Password") as HTMLInputElement, "hopper-1906");
    type(screen.getByLabelText("Full Name") as HTMLInputElement, "Grace Hopper");

    api.get.mockImplementation((path: string) =>
      path === "/api/users"
        ? new Promise((resolve) => (releaseList = resolve))
        : Promise.resolve({ configured: false })
    );
    await act(async () => {
      screen.getByRole("button", { name: "Create User" }).click();
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New User" })).toBeNull());

    act(() => screen.getByRole("button", { name: /new user/i }).click());
    const reopened = await screen.findByRole("dialog", { name: "New User" });
    expect(reopened.getAttribute("aria-busy")).toBeNull();
    escape();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New User" })).toBeNull());

    await act(async () => {
      releaseList([OTHER]);
    });
  });

  /**
   * Two saves overlapping is the case the `finally` made wrong: the first save's teardown ran after
   * its own refetch, by which time the flag it cleared belonged to the second dialog's write.
   */
  it("does not let a finished save clear the flag of the one that came after it", async () => {
    let releaseList: (value: unknown) => void = () => {};
    let releaseSecondPut: (value: unknown) => void = () => {};
    api.put.mockResolvedValueOnce({});

    render(<UsersPage />);
    await screen.findByText("Ada");

    // First save, with the refetch that follows it held open
    act(() => screen.getByText("Ada").click());
    await screen.findByRole("dialog", { name: /Edit Ada/ });
    api.get.mockImplementation((path: string) =>
      path === "/api/users"
        ? new Promise((resolve) => (releaseList = resolve))
        : Promise.resolve({ configured: false })
    );
    await act(async () => {
      screen.getByRole("button", { name: "Save" }).click();
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit Ada/ })).toBeNull());

    // Second save, still in flight, from a dialog opened while that refetch runs
    api.put.mockImplementationOnce(() => new Promise((resolve) => (releaseSecondPut = resolve)));
    act(() => screen.getByText("Ada").click());
    const second = await screen.findByRole("dialog", { name: /Edit Ada/ });
    await act(async () => {
      screen.getByRole("button", { name: "Save" }).click();
    });
    expect(second.getAttribute("aria-busy")).toBe("true");

    // The first save finishing must not unlock the second one's dialog
    await act(async () => {
      releaseList([OTHER]);
    });
    expect(second.getAttribute("aria-busy")).toBe("true");
    escape();
    expect(screen.getByRole("dialog", { name: /Edit Ada/ })).toBe(second);

    await act(async () => {
      releaseSecondPut({});
    });
  });

  /**
   * The refetch left the try/catch when the flag was shortened, and its failure path went with it:
   * a save that landed, followed by a list fetch that did not, said nothing at all and raised an
   * unhandled rejection.
   */
  it("still reports a save whose list refresh fails, and says which half failed", async () => {
    api.put.mockResolvedValue({});

    render(<UsersPage />);
    await screen.findByText("Ada");
    act(() => screen.getByText("Ada").click());
    await screen.findByRole("dialog", { name: /Edit Ada/ });

    api.get.mockImplementation((path: string) =>
      path === "/api/users"
        ? Promise.reject(new Error("network down"))
        : Promise.resolve({ configured: false })
    );
    await act(async () => {
      screen.getByRole("button", { name: "Save" }).click();
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Edit Ada/ })).toBeNull());

    expect(toast).toHaveBeenCalledWith("Saved", "success");
    // The failure is the list's, not the save's, and it says so without claiming a verb — this
    // same helper runs after a delete
    expect(toast).toHaveBeenCalledWith(
      LIST_REFRESH_FAILED,
      "error"
    );
  });

  it("does not tell somebody who deleted a user that it was saved", async () => {
    api.del.mockResolvedValue({});

    render(<UsersPage />);
    await screen.findByText("Ada");
    act(() => screen.getByText("Ada").click());
    await screen.findByRole("dialog", { name: /Edit Ada/ });
    act(() => screen.getByRole("button", { name: "Delete" }).click());
    api.get.mockImplementation((path: string) =>
      path === "/api/users"
        ? Promise.reject(new Error("network down"))
        : Promise.resolve({ configured: false })
    );
    await act(async () => {
      screen.getByRole("button", { name: "Delete User" }).click();
    });

    expect(toast).toHaveBeenCalledWith("User deleted", "success");
    // Both halves: that the refresh failure was reported at all, and that it did not claim a save
    expect(toast).toHaveBeenCalledWith(
      LIST_REFRESH_FAILED,
      "error"
    );
    expect(toast.mock.calls.map(([message]) => message).join(" ")).not.toContain("Saved");
  });

  it("says a user was created, and says separately when only the list is stale", async () => {
    api.post.mockResolvedValue({ _id: "u3", fullName: "Grace Hopper" });

    render(<UsersPage />);
    await screen.findByText("Ada");
    act(() => screen.getByRole("button", { name: /new user/i }).click());
    type(screen.getByLabelText("Username") as HTMLInputElement, "grace");
    type(screen.getByLabelText("Password") as HTMLInputElement, "hopper-1906");
    type(screen.getByLabelText("Full Name") as HTMLInputElement, "Grace Hopper");

    api.get.mockImplementation((path: string) =>
      path === "/api/users"
        ? Promise.reject(new Error("network down"))
        : Promise.resolve({ configured: false })
    );
    await act(async () => {
      screen.getByRole("button", { name: "Create User" }).click();
    });

    // The account exists. Without its own line, the only thing a create ever said was that the
    // list is stale — which reads as the create having failed.
    expect(toast).toHaveBeenCalledWith(
      "Grace Hopper's account is ready. They will see no board until you add them to one.",
      "success",
      { action: { label: "Add to a board", onClick: expect.any(Function) } }
    );
    expect(toast).toHaveBeenCalledWith(LIST_REFRESH_FAILED, "error");
    expect(screen.queryByRole("dialog", { name: "New User" })).toBeNull();
  });
});

// BP-753: a new account reaches no board, and the create toast is where the admin learns that
describe("adding a new account to a board", () => {
  async function createGrace() {
    api.post.mockResolvedValue({ _id: "u3", fullName: "Grace Hopper" });
    render(<UsersPage />);
    await screen.findByText("Ada");
    act(() => screen.getByRole("button", { name: /new user/i }).click());
    type(screen.getByLabelText("Username") as HTMLInputElement, "grace");
    type(screen.getByLabelText("Password") as HTMLInputElement, "hopper-1906");
    type(screen.getByLabelText("Full Name") as HTMLInputElement, "Grace Hopper");
    await act(async () => {
      screen.getByRole("button", { name: "Create User" }).click();
    });
    const [, , options] = toast.mock.calls.find(([message]) =>
      String(message).startsWith("Grace Hopper's account is ready")
    )!;
    return options as { action: { onClick: () => void } };
  }

  it("the toast's action opens a board picker for that person, and adding grants the chosen role", async () => {
    api.put.mockResolvedValue({ ok: true });
    const { action } = await createGrace();

    act(() => action.onClick());
    const dialog = await screen.findByRole("dialog", { name: "Add Grace Hopper to a board" });
    expect(dialog).toBeTruthy();

    const board = screen.getByLabelText("Board") as HTMLSelectElement;
    const role = screen.getByLabelText("Role") as HTMLSelectElement;
    act(() => {
      board.value = "p2";
      board.dispatchEvent(new Event("change", { bubbles: true }));
      role.value = "owner";
      role.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: "Add to board" }).click();
    });

    expect(api.put).toHaveBeenCalledWith("/api/projects/p2/members", {
      userId: "u3",
      relation: "owner",
    });
    expect(toast).toHaveBeenCalledWith("Grace Hopper is now an owner of Orbit", "success");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add Grace Hopper to a board" })).toBeNull()
    );
  });

  it("keeps the picker open and says why when the grant is refused", async () => {
    api.put.mockRejectedValue(new Error("Forbidden"));
    const { action } = await createGrace();

    act(() => action.onClick());
    await screen.findByRole("dialog", { name: "Add Grace Hopper to a board" });
    await act(async () => {
      screen.getByRole("button", { name: "Add to board" }).click();
    });

    expect(api.put).toHaveBeenCalledWith("/api/projects/p1/members", {
      userId: "u3",
      relation: "member",
    });
    expect(await screen.findByText("Forbidden")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Add Grace Hopper to a board" })).toBeTruthy();
  });
});
