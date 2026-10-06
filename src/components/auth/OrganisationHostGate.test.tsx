// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { OrganisationHostGate } from "./OrganisationHostGate";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers })));

describe("OrganisationHostGate (BP-921)", () => {
  it("says there is no organisation on a host that has none, and links to the sign-in by e-mail", async () => {
    answer(404, { error: "Not found", host: "none", signIn: "https://login.board-planner.com" });
    render(<OrganisationHostGate><p>the form</p></OrganisationHostGate>);
    expect(await screen.findByTestId("no-organisation-here")).toBeTruthy();
    expect(screen.queryByText("the form")).toBeNull();
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://login.board-planner.com");
  });

  it("says the organisation is suspended when its host answers so", async () => {
    answer(503, { suspended: true }, { "x-organisation-suspended": "1" });
    render(<OrganisationHostGate><p>the form</p></OrganisationHostGate>);
    expect(await screen.findByRole("heading", { name: "This organisation is suspended" })).toBeTruthy();
  });

  it("keeps the page on a 404 that names no host, such as an older server's", async () => {
    answer(404, { error: "Not found" });
    render(<OrganisationHostGate><p>the form</p></OrganisationHostGate>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("the form")).toBeTruthy();
  });
});
