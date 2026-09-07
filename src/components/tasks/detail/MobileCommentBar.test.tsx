// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MobileCommentBar } from "./MobileCommentBar";

/**
 * BP-591. The PM launcher is painted over this bar and steps up for anything carrying
 * `data-pinned-bottom-bar` — so the attribute is a contract with another file, not decoration.
 * Its own class list is asserted in `PmChatWidget.test.tsx`.
 */

vi.mock("@/hooks/use-api", () => ({
  useApi: () => ({ get: vi.fn().mockResolvedValue([]), post: vi.fn() }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

afterEach(cleanup);

describe("MobileCommentBar", () => {
  it("declares the bottom strip as spoken for", () => {
    render(<MobileCommentBar projectId="TP" taskId="t1" onPosted={vi.fn()} />);

    const bar = screen.getByLabelText("Add a comment").closest("[data-pinned-bottom-bar]");
    expect(bar).not.toBeNull();
  });
});
