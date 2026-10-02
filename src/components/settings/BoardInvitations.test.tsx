// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import { BoardInvitations } from "./BoardInvitations";
import { LIST_REFRESH_FAILED } from "@/lib/list-refresh";
import { ApiBoardInvitation } from "@/types";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

function row(email: string, over: Partial<ApiBoardInvitation> = {}): ApiBoardInvitation {
  return {
    _id: `id-${email}`,
    email,
    relation: "member",
    addedBy: "owner",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    expired: false,
    ...over,
  };
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function invite(email: string) {
  type(screen.getByLabelText("Email to invite") as HTMLInputElement, email);
  await act(async () => screen.getByRole("button", { name: "Invite" }).click());
}

const LINK = "https://planner.example/invite?token=cpi_abc";

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue([]);
});
afterEach(cleanup);

describe("inviting from a board", () => {
  // A link shown once is the only copy there is; a typo in the next address must not cost it
  it("keeps the one-time link through a later invitation that is refused", async () => {
    render(<BoardInvitations projectId="p1" />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    api.post.mockResolvedValueOnce({ outcome: "created", delivery: "link", link: LINK, reason: "no_mail_server" });
    await invite("ada@example.com");
    expect(screen.getByTestId("invitation-link").textContent).toBe(LINK);

    api.post.mockRejectedValueOnce(new Error("That address already has an account. Add them by username above."));
    await invite("bob@example.com");

    expect(screen.getByRole("alert").textContent).toBe(
      "That address already has an account. Add them by username above."
    );
    expect(screen.getByTestId("invitation-link").textContent).toBe(LINK);
  });

  it.each([
    ["added", "ada@example.com already had an invitation waiting; this board was added to it"],
    ["updated", "ada@example.com is already invited to this board. No email sent."],
  ])("says what an %s invitation means", async (outcome, words) => {
    render(<BoardInvitations projectId="p1" />);
    api.post.mockResolvedValueOnce({ outcome });

    await invite("ada@example.com");

    expect(toast).toHaveBeenCalledWith(words, "success");
    expect(screen.queryByTestId("invitation-link")).toBeNull();
  });

  it("says it was sent when it was mailed", async () => {
    render(<BoardInvitations projectId="p1" />);
    api.post.mockResolvedValueOnce({ outcome: "created", delivery: "email" });

    await invite("ada@example.com");

    expect(toast).toHaveBeenCalledWith("Invitation sent to ada@example.com", "success");
  });

  // Typed with capitals, stored in lower case: the withdrawn row and the shown link are one invitation
  it("forgets the link once that invitation is withdrawn, however its address was typed", async () => {
    api.get.mockResolvedValue([row("ada@example.com"), row("bob@example.com")]);
    render(<BoardInvitations projectId="p1" />);
    api.post.mockResolvedValueOnce({ outcome: "created", delivery: "link", link: LINK, reason: "no_mail_server" });
    await invite("Ada@Example.com");
    expect(screen.getByTestId("invitation-link")).toBeTruthy();
    api.del.mockResolvedValue({});

    act(() => screen.getByRole("button", { name: "Withdraw the invitation for bob@example.com" }).click());
    await act(async () => screen.getByRole("button", { name: "Withdraw" }).click());
    expect(screen.getByTestId("invitation-link")).toBeTruthy();

    act(() => screen.getByRole("button", { name: "Withdraw the invitation for ada@example.com" }).click());
    await act(async () => screen.getByRole("button", { name: "Withdraw" }).click());
    expect(screen.queryByTestId("invitation-link")).toBeNull();
  });
});

describe("reading the board's invitations", () => {
  it("offers to try again when the first read fails", async () => {
    api.get.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([row("ada@example.com")]);
    render(<BoardInvitations projectId="p1" />);

    await screen.findByText("Could not load this board's invitations.");
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());

    expect(await screen.findByText("ada@example.com")).toBeTruthy();
  });

  // The write landed; a list that cannot be re-read is out of date, not gone
  it("keeps the list on screen when a re-read after a write fails", async () => {
    api.get.mockResolvedValueOnce([row("ada@example.com")]).mockRejectedValueOnce(new Error("down"));
    render(<BoardInvitations projectId="p1" />);
    await screen.findByText("ada@example.com");
    api.post.mockResolvedValueOnce({ outcome: "created", delivery: "email" });

    await invite("bob@example.com");

    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.queryByText("Could not load this board's invitations.")).toBeNull();
    expect(toast).toHaveBeenCalledWith(LIST_REFRESH_FAILED, "error");
  });

  it("keeps the newest read when an older one answers after it", async () => {
    let releaseFirst: (rows: ApiBoardInvitation[]) => void = () => {};
    api.get
      .mockReturnValueOnce(new Promise((resolve) => (releaseFirst = resolve)))
      .mockResolvedValueOnce([row("ada@example.com"), row("new@example.com")]);
    render(<BoardInvitations projectId="p1" />);
    api.post.mockResolvedValueOnce({ outcome: "created", delivery: "email" });

    await invite("new@example.com");
    await screen.findByText("new@example.com");
    await act(async () => releaseFirst([row("ada@example.com")]));

    expect(screen.getByText("new@example.com")).toBeTruthy();
  });
});
