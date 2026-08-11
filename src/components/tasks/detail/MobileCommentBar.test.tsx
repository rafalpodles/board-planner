// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import { MobileCommentBar } from "./MobileCommentBar";

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn() } }));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

beforeEach(() => {
  api.post.mockReset();
  api.post.mockResolvedValue({});
  api.get.mockReset();
  api.get.mockResolvedValue([]);
});

afterEach(cleanup);

function renderBar() {
  const onPosted = vi.fn();
  render(<MobileCommentBar projectId="p1" taskId="t1" onPosted={onPosted} />);
  return onPosted;
}

function field() {
  return screen.getByLabelText("Add a comment") as HTMLTextAreaElement;
}

function type(value: string) {
  const el = field();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("MobileCommentBar", () => {
  // The whole point: reachable from anywhere in the task, not at the end of the page
  it("pins itself to the bottom and stays off wide screens", () => {
    renderBar();
    const bar = field().parentElement!;
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("bottom-0");
    expect(bar.className).toContain("lg:hidden");
  });

  it("will not send an empty comment", async () => {
    renderBar();
    const send = screen.getByRole("button", { name: "Post comment" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    await act(async () => type("   "));
    expect(send.disabled).toBe(true);
    await act(async () => send.click());
    expect(api.post).not.toHaveBeenCalled();
  });

  it("posts, clears itself and says so", async () => {
    const onPosted = renderBar();
    await act(async () => type("Looks good to me"));
    await act(async () => screen.getByRole("button", { name: "Post comment" }).click());

    expect(api.post).toHaveBeenCalledWith("/api/projects/p1/tasks/t1/comments", {
      body: "Looks good to me",
    });
    await waitFor(() => expect(field().value).toBe(""));
    expect(onPosted).toHaveBeenCalledTimes(1);
  });

  it("sends on Cmd+Enter", async () => {
    renderBar();
    await act(async () => type("Shipped"));
    await act(async () => {
      field().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })
      );
    });
    expect(api.post).toHaveBeenCalledWith("/api/projects/p1/tasks/t1/comments", {
      body: "Shipped",
    });
  });

  it("keeps the text when posting fails, so it is not lost", async () => {
    api.post.mockRejectedValueOnce(new Error("nope"));
    const onPosted = renderBar();
    await act(async () => type("Worth keeping"));
    await act(async () => screen.getByRole("button", { name: "Post comment" }).click());

    await waitFor(() => expect(field().value).toBe("Worth keeping"));
    expect(onPosted).not.toHaveBeenCalled();
  });
});
