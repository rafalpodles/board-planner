// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { PendingInvitations } from "./PendingInvitations";
import { ApiInvitation } from "@/types";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

function invitation(email: string): ApiInvitation {
  return {
    _id: `id-${email}`,
    email,
    role: "member",
    boards: [],
    invitedBy: { _id: "a1", username: "owner", fullName: "Owner" },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    expired: false,
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("pending invitations", () => {
  // Another admin revoked it first: the refresh empties the list, and the dialog holding the
  // refusal must neither vanish unread nor come back later naming the old address
  it("keeps a failed revoke's dialog readable when the list empties, and does not reopen it", async () => {
    api.del.mockRejectedValue(new Error("Invitation not found"));
    const onChanged = vi.fn();
    const { rerender } = render(
      <PendingInvitations invitations={[invitation("ada@example.com")]} onChanged={onChanged} />
    );

    act(() => screen.getByRole("button", { name: "Revoke the invitation for ada@example.com" }).click());
    await act(async () => screen.getByRole("button", { name: "Revoke" }).click());
    rerender(<PendingInvitations invitations={[]} onChanged={onChanged} />);

    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByText("Invitation not found")).toBeTruthy();

    act(() => screen.getByRole("button", { name: "Cancel" }).click());
    rerender(
      <PendingInvitations invitations={[invitation("grace@example.com")]} onChanged={onChanged} />
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("grace@example.com")).toBeTruthy();
  });

  it("renders nothing for an empty list", () => {
    render(<PendingInvitations invitations={[]} onChanged={vi.fn()} />);

    expect(screen.queryByText("Pending invitations")).toBeNull();
  });
});
