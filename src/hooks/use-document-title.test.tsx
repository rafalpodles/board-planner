// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useDocumentTitle } from "./use-document-title";
import { APP_NAME } from "@/lib/brand";

function Titled({ title }: { title: string | null }) {
  useDocumentTitle(title);
  return null;
}

function Page({ board, task }: { board: string | null; task?: string | null }) {
  return (
    <>
      <Titled title={board} />
      {task !== undefined && <Titled title={task} />}
    </>
  );
}

beforeEach(() => {
  document.title = APP_NAME;
});
afterEach(cleanup);

describe("useDocumentTitle", () => {
  it("names the tab while mounted and gives the plain app name back after", () => {
    const view = render(<Titled title="Orbit — Board Planner" />);
    expect(document.title).toBe("Orbit — Board Planner");

    view.unmount();
    expect(document.title).toBe(APP_NAME);
  });

  it("follows its title as it changes", () => {
    const view = render(<Titled title="Orbit — Board Planner" />);
    view.rerender(<Titled title="Orbit (1 todo) — Board Planner" />);
    expect(document.title).toBe("Orbit (1 todo) — Board Planner");
  });

  it("claims nothing while it has no title yet", () => {
    const view = render(<Page board="Orbit — Board Planner" task={null} />);
    expect(document.title).toBe("Orbit — Board Planner");

    view.rerender(<Page board="Orbit — Board Planner" task="ORB-9 Fix it — Board Planner" />);
    expect(document.title).toBe("ORB-9 Fix it — Board Planner");
  });

  it("keeps the tab for the one mounted last while the one beneath changes", () => {
    const view = render(<Page board="Orbit — Board Planner" />);
    view.rerender(<Page board="Orbit — Board Planner" task="ORB-9 Fix it — Board Planner" />);
    expect(document.title).toBe("ORB-9 Fix it — Board Planner");

    view.rerender(<Page board="Orbit (1 todo) — Board Planner" task="ORB-9 Fix it — Board Planner" />);
    expect(document.title).toBe("ORB-9 Fix it — Board Planner");
  });

  it("hands the tab back to what the one beneath says by then, not what it said before", () => {
    const view = render(<Page board="Orbit — Board Planner" />);
    view.rerender(<Page board="Orbit — Board Planner" task="ORB-9 Fix it — Board Planner" />);
    view.rerender(<Page board="Orbit (1 todo) — Board Planner" task="ORB-9 Fix it — Board Planner" />);

    view.rerender(<Page board="Orbit (1 todo) — Board Planner" />);
    expect(document.title).toBe("Orbit (1 todo) — Board Planner");
  });
});
