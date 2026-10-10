// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LIST_REFRESH_FAILED } from "@/lib/list-refresh";
import { render, screen, cleanup, act, waitFor, within, fireEvent } from "@testing-library/react";
import UsersPage from "./page";

const { api, auth, toast, dismiss, passwordSignIn } = vi.hoisted(() => ({
  passwordSignIn: { value: true as boolean | null },
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  auth: { user: { _id: "u1", username: "owner" }, isAdmin: true, isLoading: false },
  toast: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("@/hooks/use-password-sign-in", () => ({ usePasswordSignIn: () => passwordSignIn.value }));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast, dismiss }) }));
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

const otherGet = (path: string) =>
  Promise.resolve(path === "/api/invitations" ? [] : { configured: false });

beforeEach(() => {
  vi.clearAllMocks();
  passwordSignIn.value = true;
  toast.mockClear();
  api.get.mockImplementation((path: string) =>
    path === "/api/users" ? Promise.resolve([OTHER]) : otherGet(path)
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
        : otherGet(path)
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
        : otherGet(path)
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
        : otherGet(path)
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
        : otherGet(path)
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
        : otherGet(path)
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
        : otherGet(path)
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

  it("takes its offer down when the admin leaves the page it would open on", async () => {
    toast.mockReturnValue(41);
    await createGrace();
    expect(dismiss).not.toHaveBeenCalled();

    cleanup();

    expect(dismiss).toHaveBeenCalledWith(41);
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

describe("the users page, when a delete is refused", () => {
  const REFUSAL =
    "ada is the only owner of Orbit (ORB). Make someone else an owner there before deleting this account.";

  async function refuseDelete() {
    api.del.mockRejectedValue(Object.assign(new Error(REFUSAL), { status: 409 }));
    render(<UsersPage />);
    await screen.findByText("Ada");
    act(() => screen.getByText("Ada").click());
    await screen.findByRole("dialog", { name: /Edit Ada/ });
    act(() => screen.getByRole("button", { name: "Delete" }).click());
    await act(async () => {
      screen.getByRole("button", { name: "Delete User" }).click();
    });
  }

  it("keeps the dialog open and shows the server's reason in it", async () => {
    await refuseDelete();

    const dialog = screen.getByRole("dialog", { name: "Delete User" });
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(REFUSAL);
    expect(toast).not.toHaveBeenCalledWith("User deleted", "success");
  });

  it("does not carry the reason into the next time the dialog opens", async () => {
    await refuseDelete();
    act(() => screen.getByRole("button", { name: "Cancel" }).click());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete User" })).toBeNull());

    act(() => screen.getByText("Ada").click());
    await screen.findByRole("dialog", { name: /Edit Ada/ });
    act(() => screen.getByRole("button", { name: "Delete" }).click());

    const dialog = await screen.findByRole("dialog", { name: "Delete User" });
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
  });
});

// BP-841. A refusal about the role is not the address field's to show
describe("a save refused for the role", () => {
  it("says so in a toast, leaving the address field unmarked", async () => {
    api.put.mockRejectedValue(Object.assign(new Error("Cannot demote the last admin"), { status: 409 }));
    render(<UsersPage />);
    await screen.findByText("Ada");
    act(() => screen.getByText("Ada").click());
    const dialog = await screen.findByRole("dialog", { name: /Edit Ada/ });

    await act(async () => within(dialog).getByRole("button", { name: "Save" }).click());

    expect(toast).toHaveBeenCalledWith("Cannot demote the last admin", "error");
    expect(within(dialog).queryByText("Cannot demote the last admin")).toBeNull();
  });
});

describe("the users page with password sign-in off (BP-830)", () => {
  it("offers no account with a password and no password to hand out", async () => {
    passwordSignIn.value = false;

    render(<UsersPage />);
    await screen.findByText("Ada");
    expect(screen.queryByRole("button", { name: "New User" })).toBeNull();

    act(() => screen.getByText("Ada").click());
    await screen.findByRole("dialog", { name: /Edit Ada/ });
    expect(screen.queryByLabelText("Set a new password")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeTruthy();
  });

  // Drawn as on until the answer comes: the default, and never a blank where the button was
  it("draws the password actions while the answer is still coming", async () => {
    passwordSignIn.value = null;

    render(<UsersPage />);
    await screen.findByText("Ada");

    expect(screen.getByRole("button", { name: "New User" })).toBeTruthy();
  });

  it("offers to confirm an address nothing has proven, and sends it", async () => {
    api.get.mockImplementation((path: string) =>
      path === "/api/users"
        ? Promise.resolve([{ ...OTHER, email: "ada@example.com", emailVerifiedAt: null }])
        : otherGet(path)
    );
    api.put.mockResolvedValue({ ok: true });

    render(<UsersPage />);
    await screen.findByText("Ada");
    act(() => screen.getByText("Ada").click());
    await screen.findByRole("dialog", { name: /Edit Ada/ });
    act(() => screen.getByRole("button", { name: "Confirm address" }).click());
    // Said before it is done: a confirmed address opens the account to whoever holds it at a provider
    const ask = await screen.findByRole("dialog", { name: "Confirm address" });
    expect(ask.textContent).toContain("Whoever holds ada@example.com at a sign-in provider will be able to sign in as ada");
    expect(api.put).not.toHaveBeenCalled();
    await act(async () => within(ask).getByRole("button", { name: "Confirm address" }).click());

    expect(api.put).toHaveBeenCalledWith("/api/users/u2", { confirmEmail: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm address" })).toBeNull());
  });
});

// BP-844
describe("the account actions in the edit dialog", () => {
  it("re-reads the list after signing somebody out everywhere, whose providers that unlinked", async () => {
    api.put.mockResolvedValue({ ok: true });
    render(<UsersPage />);
    await screen.findByText("Ada");
    act(() => screen.getByText("Ada").click());
    await screen.findByRole("dialog", { name: /Edit Ada/ });
    act(() => screen.getByRole("button", { name: "Sign out everywhere" }).click());
    const ask = await screen.findByRole("dialog", { name: "Sign out everywhere" });
    const readsBefore = api.get.mock.calls.filter(([path]) => path === "/api/users").length;

    await act(async () => within(ask).getByRole("button", { name: "Sign out everywhere" }).click());

    await waitFor(() =>
      expect(api.get.mock.calls.filter(([path]) => path === "/api/users").length).toBeGreaterThan(readsBefore)
    );
  });

  it("holds the account actions while something typed in the dialog is unsaved", async () => {
    api.get.mockImplementation((path: string) =>
      path === "/api/users"
        ? Promise.resolve([{ ...OTHER, email: "ada@example.com", emailVerifiedAt: null }])
        : otherGet(path)
    );
    render(<UsersPage />);
    await screen.findByText("Ada");
    act(() => screen.getByText("Ada").click());
    const dialog = await screen.findByRole("dialog", { name: /Edit Ada/ });
    const actions = ["Confirm address", "Sign out everywhere", "Deactivate", "Delete"];
    for (const name of actions) {
      expect((within(dialog).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    }

    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "new@example.com" } });

    expect(within(dialog).getByText("Save or cancel your changes first.")).toBeTruthy();
    for (const name of actions) {
      expect((within(dialog).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    // Said to a screen reader too, which otherwise hears only that they are dimmed
    for (const name of ["Confirm address", "Sign out everywhere", "Deactivate"]) {
      expect(within(dialog).getByRole("button", { name }).getAttribute("aria-describedby")).toBe("unsavedEditHint");
    }
  });

  it.each([
    ["nothing reaches them", false, ""],
    ["their address is told", true, "ada@example.com"],
  ])("says that setting a password unlinks their sign-in providers, when %s", async (_label, configured, email) => {
    api.get.mockImplementation((path: string) =>
      path === "/api/users"
        ? Promise.resolve([{ ...OTHER, email }])
        : path === "/api/invitations"
          ? Promise.resolve([])
          : Promise.resolve({ configured })
    );
    render(<UsersPage />);
    await screen.findByText("Ada");
    act(() => screen.getByText("Ada").click());
    await screen.findByRole("dialog", { name: /Edit Ada/ });

    expect(await screen.findByText(configured ? /is told that it changed/ : /Nothing reaches them either/)).toBeTruthy();
    expect(screen.getByText(/unlinks their sign-in providers/)).toBeTruthy();
  });
});

describe("who the list shows, and how they sign in (BP-831)", () => {
  const PEOPLE = [
    { ...OTHER, _id: "u2", username: "ada", fullName: "Ada", lastActiveAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), signInMethods: ["Password", "Acme SSO"] },
    { ...OTHER, _id: "u3", username: "grace", fullName: "Grace", lastActiveAt: null, signInMethods: [] },
    { ...OTHER, _id: "u4", username: "linus", fullName: "Linus", deactivatedAt: new Date().toISOString(), signInMethods: ["Password"] },
  ];
  const INVITED = [{ _id: "i1", email: "new@example.com", role: "member", boards: [], invitedBy: { username: "owner" }, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), expired: false }];

  beforeEach(() => {
    api.get.mockImplementation((path: string) =>
      path === "/api/users" ? Promise.resolve(PEOPLE) : path === "/api/invitations" ? Promise.resolve(INVITED) : otherGet(path)
    );
  });

  it("says when each person last signed in, and by what", async () => {
    render(<UsersPage />);
    await screen.findByText("Ada");

    expect(screen.getByText("Last active 3d ago · Password, Acme SSO")).toBeTruthy();
    expect(screen.getByText("No sign-in recorded · No way to sign in")).toBeTruthy();
  });

  it("filters by status, counting each", async () => {
    render(<UsersPage />);
    await screen.findByText("Ada");
    expect(screen.getByRole("button", { name: "All 4" })).toBeTruthy();

    act(() => screen.getByRole("button", { name: "Deactivated 1" }).click());
    expect(screen.queryByText("Ada")).toBeNull();
    expect(screen.getByText("Linus")).toBeTruthy();
    expect(screen.queryByText("new@example.com")).toBeNull();

    act(() => screen.getByRole("button", { name: "Invited 1" }).click());
    expect(screen.queryByText("Linus")).toBeNull();
    expect(screen.getByText("new@example.com")).toBeTruthy();

    act(() => screen.getByRole("button", { name: "Active 2" }).click());
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("Grace")).toBeTruthy();
    expect(screen.queryByText("Linus")).toBeNull();
  });
});
