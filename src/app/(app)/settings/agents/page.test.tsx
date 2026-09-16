// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AdminAgentsPage from "./page";

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isAdmin: true, isLoading: false }) }));
// One router for every render, as Next gives: a new object each time re-runs the page's load effect
const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const ROW = {
  _id: "p1",
  key: "BP",
  name: "Board",
  enabled: true,
  lockedByInstance: false,
  model: "",
  dailyTurnCap: 50,
  autonomy: { dailyReview: false, reviewIntervalHours: 24, handleNeedsHumanReview: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(async (url: string) =>
    url === "/api/settings"
      ? { aiModel: "" }
      : { pmAvailable: true, defaults: { pmDefaultModel: "", pmDefaultDailyTurnCap: 0, envModel: "m" }, projects: [ROW] }
  );
});
afterEach(cleanup);

// BP-471: the row's save answered with every field as stored, and the merge took all of them
describe("a governance row while one field's save is in flight", () => {
  it("keeps the turn cap typed meanwhile when the model's save lands", async () => {
    let answerModel!: (row: unknown) => void;
    api.patch.mockImplementationOnce(() => new Promise((resolve) => (answerModel = resolve)));
    render(<AdminAgentsPage />);
    const model = await screen.findByLabelText("PM model for BP — Board");
    const cap = screen.getByLabelText("Daily turn cap for BP — Board") as HTMLInputElement;

    fireEvent.change(model, { target: { value: "e2e/governed-model" } });
    fireEvent.blur(model);
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    fireEvent.change(cap, { target: { value: "7" } });

    // The model's answer carries the cap as it was stored before the edit
    await act(async () => answerModel({ ...ROW, model: "e2e/governed-model", dailyTurnCap: 50 }));

    expect(cap.value).toBe("7");
    expect((screen.getByLabelText("PM model for BP — Board") as HTMLInputElement).value).toBe("e2e/governed-model");
  });
});
