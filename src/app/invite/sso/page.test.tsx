// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import SsoAcceptancePage from "./page";

const passwordSignIn = vi.hoisted(() => ({ value: true as boolean | null }));
vi.mock("@/hooks/use-password-sign-in", () => ({ usePasswordSignIn: () => passwordSignIn.value }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ refreshUser: vi.fn() }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("error=mismatch"),
}));

beforeEach(() => {
  passwordSignIn.value = true;
});
afterEach(cleanup);

// BP-844
describe("an invitation accepted with a provider at another address", () => {
  it("offers choosing a password instead while passwords sign anybody in", async () => {
    render(<SsoAcceptancePage />);

    expect((await screen.findByRole("alert")).textContent).toContain("open the invitation link again and choose a password");
  });

  it("offers no password where nobody chooses one", async () => {
    passwordSignIn.value = false;

    render(<SsoAcceptancePage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("then open the invitation link again");
    expect(alert.textContent).not.toContain("password");
  });
});
