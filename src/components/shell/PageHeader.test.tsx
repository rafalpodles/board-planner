// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";
import { PageHeader } from "./PageHeader";

afterEach(cleanup);

describe("PageHeader", () => {
  it("matches the board's 56px header shell", () => {
    const { container } = render(<PageHeader title="Sprints" />);
    const header = container.querySelector("header")!;
    expect(header.className).toContain("h-14");
    expect(header.className).toContain("border-b");
  });

  it("renders the title as the page's only h1", () => {
    render(<PageHeader title="Sprints" subtitle="3 sprints" />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sprints");
    expect(screen.getByText("3 sprints")).toBeTruthy();
  });

  it("omits the subtitle, icon and action slots when unused", () => {
    const { container } = render(<PageHeader title="Search" />);
    expect(container.querySelectorAll("header > *")).toHaveLength(1);
  });

  it("places actions after the title", () => {
    render(<PageHeader title="Notifications" actions={<button>Mark all as read</button>} />);
    const heading = screen.getByRole("heading", { level: 1 });
    const action = screen.getByText("Mark all as read");
    expect(heading.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides the icon from assistive tech", () => {
    const { container } = render(<PageHeader title="Settings" icon="📋" />);
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe("📋");
  });
});

describe("no page reintroduces the old header idiom", () => {
  const APP = join(process.cwd(), "src/app/(app)");

  function pages(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return pages(path);
      return /^(page|layout)\.tsx$/.test(entry) ? [path] : [];
    });
  }

  const offenders = pages(APP).filter((file) =>
    /<h1[^>]*className="[^"]*text-2xl/.test(readFileSync(file, "utf8"))
  );

  it("finds none", () => {
    expect(offenders.map((f) => f.replace(`${APP}/`, ""))).toEqual([]);
  });
});
