// @vitest-environment happy-dom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import NotificationsPage from "./page";
import { NotificationMatrix, NotificationType } from "@/types";

/**
 * BP-465. The page seeds `matrix`, the chat connection and the digest box from one load effect.
 * React runs a mount effect twice under Strict Mode — which is what `next dev` serves, and what
 * the e2e suite drives — so two reads are in flight and the slower one answers last. Without a
 * race guard that answer is applied on top of whatever has been ticked or typed since the first
 * one painted the screen, and the save that follows carries the server's grid rather than the
 * reader's. The same guard is on the project section next door (BP-553).
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { _id: "u1", username: "member" }, refreshUser: vi.fn() }),
}));

const EVENTS: NotificationType[] = [
  "task_assigned",
  "status_changed",
  "comment_added",
  "mentioned",
  "task_created",
];

function grid(on: boolean): NotificationMatrix {
  return Object.fromEntries(
    EVENTS.map((event) => [event, { inApp: on, email: on, chat: false }])
  ) as NotificationMatrix;
}

const prefs = (matrix: NotificationMatrix) => ({
  defaults: matrix,
  projects: [],
  chat: { kind: "", configured: false },
});

const answerFor = (path: string, matrix: NotificationMatrix) =>
  path === "/api/users/me/notifications" ? prefs(matrix) : { emailDigest: false };

const ASSIGNED_EMAIL = "A task is assigned to you — E-mail";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("the notifications page while its load effect is running twice", () => {
  it("does not paint a superseded read over a cell the reader has just ticked", async () => {
    // Strict Mode mounts, cleans up, and mounts again, so the effect runs twice and each run reads
    // both endpoints. The first run's two reads are held; the second run's come back straight
    // away, and are what paints the screen.
    let releaseSuperseded!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseSuperseded = resolve;
    });

    let call = 0;
    api.get.mockImplementation((path: string) => {
      call += 1;
      // The grid as the server still has it, in both runs: what separates the versions is not the
      // value but whether a cleaned-up run's answer is allowed to land at all.
      return call <= 2
        ? held.then(() => answerFor(path, grid(false)))
        : Promise.resolve(answerFor(path, grid(false)));
    });

    render(
      <StrictMode>
        <NotificationsPage />
      </StrictMode>
    );

    const cell = (await screen.findByLabelText(ASSIGNED_EMAIL)) as HTMLInputElement;
    expect(cell.checked).toBe(false);
    expect(call).toBe(4);

    await act(async () => {
      fireEvent.click(cell);
    });
    expect((screen.getByLabelText(ASSIGNED_EMAIL) as HTMLInputElement).checked).toBe(true);

    // The superseded read answers now. It belongs to a run that was cleaned up before the reader
    // ever saw this screen, so it has nothing to say about what is on it.
    await act(async () => {
      releaseSuperseded();
      await held;
    });

    await waitFor(() =>
      expect((screen.getByLabelText(ASSIGNED_EMAIL) as HTMLInputElement).checked).toBe(true)
    );
  });

  // The digest box is the one control on this screen that does not wait for Save: `toggleDigest`
  // PUTs on change. So a superseded answer cannot undo a save here — it leaves the box showing
  // the opposite of what was just stored, which is the worse failure of the two.
  it("does not leave the digest box disagreeing with what it just stored", async () => {
    let releaseSuperseded!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseSuperseded = resolve;
    });

    let call = 0;
    api.get.mockImplementation((path: string) => {
      call += 1;
      return call <= 2
        ? held.then(() => answerFor(path, grid(false)))
        : Promise.resolve(answerFor(path, grid(false)));
    });

    render(
      <StrictMode>
        <NotificationsPage />
      </StrictMode>
    );

    const digest = (await screen.findByLabelText(
      "Collect the e-mail column into one daily digest"
    )) as HTMLInputElement;
    expect(digest.checked).toBe(false);

    await act(async () => {
      fireEvent.click(digest);
    });
    expect(api.put).toHaveBeenCalledWith("/api/users/me", { emailDigest: true });

    await act(async () => {
      releaseSuperseded();
      await held;
    });

    await waitFor(() =>
      expect(
        (
          screen.getByLabelText(
            "Collect the e-mail column into one daily digest"
          ) as HTMLInputElement
        ).checked
      ).toBe(true)
    );
  });

  // The other two halves of the guard, which the tick above cannot reach: it holds the first run,
  // so that run always answers last. Here the first run answers first, which is the ordinary case.
  it("does not report the screen unloadable because a superseded read failed", async () => {
    let call = 0;
    api.get.mockImplementation((path: string) => {
      call += 1;
      // The superseded run fails outright. The surviving one is fine, and is the only one whose
      // answer describes this screen.
      return call <= 2
        ? Promise.reject(new Error("the read that was replaced"))
        : Promise.resolve(answerFor(path, grid(false)));
    });

    render(
      <StrictMode>
        <NotificationsPage />
      </StrictMode>
    );

    await screen.findByLabelText(ASSIGNED_EMAIL);
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  it("does not flash the unloadable panel while the surviving read is still in flight", async () => {
    let releaseSurviving!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseSurviving = resolve;
    });

    let call = 0;
    api.get.mockImplementation((path: string) => {
      call += 1;
      return call <= 2
        ? Promise.resolve(answerFor(path, grid(false)))
        : held.then(() => answerFor(path, grid(false)));
    });

    render(
      <StrictMode>
        <NotificationsPage />
      </StrictMode>
    );

    // The superseded run has answered by now; the surviving one has not. Nothing it did may reach
    // the screen — including flipping `loaded`, which with no matrix renders the failure panel.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/could not be loaded/)).toBeNull();

    await act(async () => {
      releaseSurviving();
      await held;
    });
    await screen.findByLabelText(ASSIGNED_EMAIL);
  });
});
