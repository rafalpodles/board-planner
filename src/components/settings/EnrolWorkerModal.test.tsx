// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
import { EnrolWorkerModal } from "./EnrolWorkerModal";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(), upload: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const DOWNLOAD = "https://board-planner.com/docs/ai/execution-workers/#getting-the-software";

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("EnrolWorkerModal", () => {
  it("points at the download before a token is minted", () => {
    render(<EnrolWorkerModal open onClose={() => {}} />);

    const link = screen.getByRole("link", { name: "Getting the software" });
    expect(link.getAttribute("href")).toBe(DOWNLOAD);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("makes installing the worker the first step on the machine once a token is minted", async () => {
    api.post.mockResolvedValue({
      token: "cpe_abc",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    render(<EnrolWorkerModal open onClose={() => {}} />);

    await act(async () => {
      screen.getByRole("button", { name: "Mint token" }).click();
    });

    expect(screen.getByText("cpe_abc")).toBeTruthy();
    const firstStep = screen.getAllByRole("listitem")[0];
    expect(
      within(firstStep).getByRole("link", { name: "Getting the software" }).getAttribute("href")
    ).toBe(DOWNLOAD);
  });

  it("asks the machine for the enrolment token and no second credential", async () => {
    api.post.mockResolvedValue({
      token: "cpe_abc",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    render(<EnrolWorkerModal open onClose={() => {}} />);

    await act(async () => {
      screen.getByRole("button", { name: "Mint token" }).click();
    });

    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[1].textContent).toContain("CP_ENROLMENT_TOKEN_FILE");
    expect(screen.getByRole("dialog").textContent).not.toContain("CP_API_TOKEN");
  });
});
