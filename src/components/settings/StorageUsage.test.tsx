// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StorageUsage } from "./StorageUsage";

const { api } = vi.hoisted(() => ({ api: { get: vi.fn() } }));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));

const MB = 1024 * 1024;
const show = () => render(<dl><StorageUsage /></dl>);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("storage on the organisation page (BP-967)", () => {
  it("shows what is used against the ceiling, as a bar", async () => {
    api.get.mockResolvedValue({ storedBytes: 300 * MB, limitBytes: 1024 * MB, upgradeLifts: true });
    show();

    expect((await screen.findByTestId("organisation-storage-used")).textContent).toBe("300 MB of 1 GB");
    const bar = screen.getByRole("progressbar", { name: "File storage used" });
    expect(bar.getAttribute("aria-valuenow")).toBe(String(300 * MB));
    expect(bar.getAttribute("aria-valuetext")).toBe("300 MB of 1 GB");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("29%");
    expect(api.get).toHaveBeenCalledWith("/api/organisation/storage");
  });

  it("turns the bar red from 90% of the ceiling and not before, and never draws past the end", async () => {
    const fill = async (stored: number) => {
      cleanup();
      api.get.mockResolvedValue({ storedBytes: stored * MB, limitBytes: 1000 * MB, upgradeLifts: false });
      show();
      await screen.findByTestId("organisation-storage-used");
      return screen.getByRole("progressbar");
    };

    expect((await fill(899)).firstElementChild?.className).toContain("bg-primary");
    expect((await fill(900)).firstElementChild?.className).toContain("bg-danger");
    const over = await fill(1500);
    expect(over.getAttribute("aria-valuenow")).toBe(String(1000 * MB));
    expect((over.firstElementChild as HTMLElement).style.width).toBe("100%");
  });

  it("tells a Free organisation what Pro includes while there is room", async () => {
    api.get.mockResolvedValue({ storedBytes: 300 * MB, limitBytes: 1024 * MB, upgradeLifts: true });
    show();

    expect((await screen.findByTestId("organisation-storage-free")).textContent).toBe("Pro includes 20 GB.");
    expect(screen.queryByTestId("organisation-storage-full")).toBeNull();
  });

  it("says a full Free organisation can upload no more, and what lifts it", async () => {
    api.get.mockResolvedValue({ storedBytes: 1024 * MB, limitBytes: 1024 * MB, upgradeLifts: true });
    show();

    const full = await screen.findByTestId("organisation-storage-full");
    expect(full.textContent).toBe("Full, so no more files can be uploaded. Upgrade to Pro for 20 GB.");
    expect(full.getAttribute("role")).toBeNull();
    expect(screen.getByRole("progressbar").firstElementChild?.className).toContain("bg-danger");
  });

  it("offers no upgrade where a plan does not lift the ceiling", async () => {
    api.get.mockResolvedValue({ storedBytes: 20480 * MB, limitBytes: 20480 * MB, upgradeLifts: false });
    show();

    expect((await screen.findByTestId("organisation-storage-full")).textContent).toBe("Full, so no more files can be uploaded.");
    expect(screen.queryByTestId("organisation-storage-free")).toBeNull();
  });

  it("shows the size alone, with no bar, where nothing limits it", async () => {
    api.get.mockResolvedValue({ storedBytes: 2048 * MB, limitBytes: null, upgradeLifts: false });
    show();

    expect((await screen.findByTestId("organisation-storage-used")).textContent).toBe("2 GB");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("says it could not be read rather than showing nothing", async () => {
    api.get.mockRejectedValue(new Error("down"));
    show();

    expect((await screen.findByTestId("organisation-storage")).textContent).toBe("Could not be read.");
  });
});
