// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SetupGuideCard, SetupGuidePanel } from "./SetupGuide";
import type { ApiSetupGuide } from "@/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

function guide(done: string[], over: Partial<Record<string, { locked?: boolean }>> = {}): ApiSetupGuide {
  const steps = [
    ["tasks", "board"],
    ["team", "board"],
    ["repository", "connections"],
    ["runs", "agents"],
    ["machine", "agents"],
  ] as const;
  return {
    show: true,
    steps: steps.map(([id, group]) => ({ id, group, done: done.includes(id), locked: !!over[id]?.locked })),
  };
}

describe("SetupGuideCard", () => {
  it("says how far along it is and what comes next", () => {
    render(<SetupGuideCard guide={guide(["tasks"])} compact={false} onOpen={vi.fn()} />);

    expect(screen.getByTestId("setup-guide-count").textContent).toBe("1 of 5 done");
    expect(screen.getByTestId("setup-guide-card").textContent).toContain("Invite your team");
  });

  it("opens on a click", () => {
    const onOpen = vi.fn();
    render(<SetupGuideCard guide={guide([])} compact={false} onOpen={onOpen} />);

    fireEvent.click(screen.getByTestId("setup-guide-card"));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("is only the ring on the collapsed rail, and says the rest in its label", () => {
    render(<SetupGuideCard guide={guide(["tasks"])} compact onOpen={vi.fn()} />);

    const button = screen.getByTestId("setup-guide-card");
    expect(button.getAttribute("aria-label")).toBe("Setup guide, 1 of 5 done. Next: Invite your team");
    expect(screen.queryByTestId("setup-guide-count")).toBeNull();
  });
});

describe("SetupGuidePanel", () => {
  const render_ = (g: ApiSetupGuide, handlers: { onClose?: () => void; onHide?: () => void } = {}) =>
    render(
      <SetupGuidePanel guide={g} projectRef="ORB" onClose={handlers.onClose ?? vi.fn()} onHide={handlers.onHide ?? vi.fn()} />
    );

  it("leads with the first step still to do, with its action", () => {
    render_(guide(["tasks"]));

    const next = screen.getByTestId("setup-guide-next");
    expect(next.textContent).toContain("Invite your team");
    expect(next.querySelector("a")?.getAttribute("href")).toBe("/projects/ORB/settings?section=general");
  });

  it("groups the steps, counts each group, and opens the one with the next step", () => {
    render_(guide(["tasks"]));

    const groups = screen.getAllByTestId("setup-guide-group");
    expect(groups.map((g) => g.getAttribute("data-group"))).toEqual(["board", "connections", "agents"]);
    expect(groups[0].textContent).toContain("1/2");
    expect(screen.getAllByTestId("setup-guide-step").map((s) => s.getAttribute("data-step"))).toEqual(["tasks", "team"]);
  });

  it("marks a done step done for a screen reader as well", () => {
    render_(guide(["tasks"]));

    const done = screen.getAllByTestId("setup-guide-step")[0];
    expect(done.getAttribute("data-done")).toBe("true");
    expect(done.textContent).toContain("(done)");
  });

  it("opens another group and says why a step is there, once it is chosen", () => {
    render_(guide([]));

    fireEvent.click(screen.getByRole("button", { name: /Connections/ }));
    fireEvent.click(screen.getByText("Link a repository"));

    expect(screen.getByText("Pull requests show up on their tasks, with CI status.")).toBeTruthy();
  });

  it("sends the machine step to the docs, outside the app", () => {
    render_(guide(["tasks", "team", "repository", "runs"]));

    const link = screen.getByTestId("setup-guide-next").querySelector("a")!;
    expect(link.getAttribute("href")).toMatch(/\/docs\/ai\/execution-workers\//);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("names the instance lock instead of offering a link nobody can follow", () => {
    render_(guide(["tasks", "team", "repository"], { runs: { locked: true } }));

    const next = screen.getByTestId("setup-guide-next");
    expect(next.textContent).toContain("An instance admin has locked agent runs off for this board.");
    expect(next.querySelector("a")).toBeNull();
  });

  it("goes back and hides through the handlers it is given", () => {
    const onClose = vi.fn();
    const onHide = vi.fn();
    render_(guide([]), { onClose, onHide });

    fireEvent.click(screen.getByTestId("setup-guide-close"));
    fireEvent.click(screen.getByTestId("setup-guide-hide"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});

describe("where the steps send you", () => {
  const hrefOf = (id: string) => {
    const g: ApiSetupGuide = {
      show: true,
      steps: [{ id: id as ApiSetupGuide["steps"][number]["id"], group: "connections", done: false, locked: false }],
    };
    const { unmount } = render(<SetupGuidePanel guide={g} projectRef="ORB" onClose={vi.fn()} onHide={vi.fn()} />);
    const href = screen.getByTestId("setup-guide-next").querySelector("a")!.getAttribute("href");
    unmount();
    return href;
  };

  // The team's channel is added under Integrations; Notifications is the reader's own grid
  it("puts the team channel and the webhook under Integrations, not under the reader's own notifications", () => {
    expect(hrefOf("channel")).toBe("/projects/ORB/settings?section=integrations");
    expect(hrefOf("webhook")).toBe("/projects/ORB/settings?section=integrations");
    expect(hrefOf("repository")).toBe("/projects/ORB/settings?section=integrations");
  });
});
