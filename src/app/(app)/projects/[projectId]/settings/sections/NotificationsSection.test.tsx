// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { NotificationsSection } from "./NotificationsSection";
import { NotificationMatrix, NotificationType } from "@/types";
import type { SectionProps } from "./types";

/**
 * BP-553. The section seeds `matrix` — the reader's own grid, held unsaved until they press Save —
 * from a load effect keyed on the project. The settings shell keeps the section mounted across a
 * move from one project to another, so without a race guard the previous project's answer lands on
 * the new project's screen, and `save()` then PUTs that grid under this project's id.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

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

function prefs(project: string, matrix: NotificationMatrix) {
  return {
    defaults: grid(false),
    projects: [{ project, matrix }],
    chat: { configured: false },
  };
}

const props = (id: string) =>
  ({
    projectId: id,
    project: { _id: id, key: "BP", name: id },
    patchProject: vi.fn(),
    replaceProject: vi.fn(),
    isAdmin: true,
  }) as unknown as SectionProps;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("NotificationsSection across a change of project", () => {
  it("does not paint the previous project's grid over this one", async () => {
    // A's read is slow; B's answers straight away
    let releaseA!: (value: unknown) => void;
    const slow = new Promise((resolve) => {
      releaseA = resolve;
    });
    api.get.mockReturnValueOnce(slow).mockResolvedValue(prefs("b", grid(false)));

    const { rerender } = render(<NotificationsSection {...props("a")} />);
    rerender(<NotificationsSection {...props("b")} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Use my own settings for this project")).toBeTruthy()
    );

    // A answers now, with everything switched on — B's screen must not take it
    await act(async () => {
      releaseA(prefs("a", grid(true)));
      await Promise.resolve();
    });

    // The override box itself is B's own state; what must not arrive is A's grid
    const cells = screen
      .queryAllByRole("checkbox")
      .filter((box) => box.id !== "overrideNotifications") as HTMLInputElement[];
    expect(cells.length, "the grid is on screen").toBeGreaterThan(0);
    expect(
      cells.filter((box) => box.checked),
      "B's grid is B's, and B's is empty"
    ).toHaveLength(0);
  });
});
