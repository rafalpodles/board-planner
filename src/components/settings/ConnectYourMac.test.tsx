// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { ConnectYourMac } from "./ConnectYourMac";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const writeText = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

/**
 * BP-1133. Settings → Machines led with the token route for Linux; a Mac, the main route, got one
 * sentence and a link to the docs.
 */
describe("Connect your Mac", () => {
  it("shows the three Homebrew commands, trusting the tap before installing from it", () => {
    render(<ConnectYourMac />);

    expect(screen.getByTestId("brew-install").textContent!.split("\n")).toEqual([
      "brew tap rafalpodles/tap",
      "brew trust --cask rafalpodles/tap/board-planner-worker",
      "brew install --cask rafalpodles/tap/board-planner-worker",
    ]);
  });

  it("copies exactly the commands it shows", async () => {
    writeText.mockResolvedValue(undefined);
    render(<ConnectYourMac />);

    await act(async () => screen.getByRole("button", { name: "Copy" }).click());

    expect(writeText).toHaveBeenCalledWith(screen.getByTestId("brew-install").textContent);
    expect(screen.getByRole("button", { name: "Copied!" })).toBeTruthy();
  });

  it("says so when the clipboard refuses", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<ConnectYourMac />);

    await act(async () => screen.getByRole("button", { name: "Copy" }).click());

    expect(toast).toHaveBeenCalledWith("Copy failed — select the commands and copy them manually", "error");
  });

  it("offers the download for a Mac without Homebrew", () => {
    render(<ConnectYourMac />);

    expect(screen.getByRole("link", { name: "Download the app" }).getAttribute("href")).toBe(
      "https://github.com/rafalpodles/board-planner/releases/latest"
    );
  });
});
