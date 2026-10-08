// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const useAuth = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-auth", () => ({ useAuth }));

const { AiNeedsKey } = await import("./AiNeedsKey");

afterEach(cleanup);

describe("what a Free cloud organisation sees where an AI feature would be", () => {
  it("offers an administrator both ways out, each a link to where it is done", () => {
    useAuth.mockReturnValue({ isAdmin: true });
    render(<AiNeedsKey what="AI Assist" />);

    expect(screen.getByText("AI Assist runs on your own OpenRouter key on the Free plan.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add a key" }).getAttribute("href")).toBe("/settings/ai-keys");
    expect(screen.getByRole("link", { name: "upgrade to Pro" }).getAttribute("href")).toBe("/settings/organisation");
  });

  it("tells a member whom to ask instead of linking a page that would turn them away", () => {
    useAuth.mockReturnValue({ isAdmin: false });
    render(<AiNeedsKey what="The PM agent" />);

    expect(screen.getByText(/Ask an administrator of this organisation/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
