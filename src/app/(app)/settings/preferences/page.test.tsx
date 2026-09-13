// @vitest-environment happy-dom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PreferencesPage from "./page";

/**
 * BP-601, the shape BP-465 measured on the notifications screen. Strict Mode — what `next dev`
 * serves — runs the mount effect twice, so two reads are in flight; the switch saves on change,
 * so a superseded answer landing after the save leaves the screen showing the opposite of what
 * the server now holds.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { _id: "u1", username: "member" }, refreshUser: vi.fn() }),
}));

const LABEL = "Collapse empty columns";
const box = () => screen.getByLabelText(LABEL) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  api.put.mockResolvedValue({});
});
afterEach(cleanup);

describe("the preferences page while its load effect is running twice", () => {
  it("does not paint a superseded read over the switch the reader has just turned off", async () => {
    let releaseSuperseded!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseSuperseded = resolve;
    });

    let call = 0;
    api.get.mockImplementation(() => {
      call += 1;
      // The same value in both runs: what separates them is not what they say but whether a
      // cleaned-up run's answer may land at all.
      return call === 1
        ? held.then(() => ({ collapseEmptyColumns: true }))
        : Promise.resolve({ collapseEmptyColumns: true });
    });

    render(
      <StrictMode>
        <PreferencesPage />
      </StrictMode>
    );

    await waitFor(() => expect(box().checked).toBe(true));

    await act(async () => {
      fireEvent.click(box());
    });
    expect(api.put).toHaveBeenCalledWith("/api/users/me", { collapseEmptyColumns: false });
    expect(box().checked).toBe(false);

    await act(async () => {
      releaseSuperseded();
      await held;
    });

    await waitFor(() => expect(box().checked).toBe(false));
  });

  it("still shows the switch when the superseded read is the one that failed", async () => {
    let call = 0;
    api.get.mockImplementation(() => {
      call += 1;
      return call === 1
        ? Promise.reject(new Error("the read that was replaced"))
        : Promise.resolve({ collapseEmptyColumns: false });
    });

    render(
      <StrictMode>
        <PreferencesPage />
      </StrictMode>
    );

    await waitFor(() => expect(box().checked).toBe(false));
  });
});
