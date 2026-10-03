// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ApiProject } from "@/types";
import { SettingsProvider } from "@/components/settings/settings-context";

const entitlement = vi.hoisted(() => ({ loading: false, entitled: true }));
const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
vi.mock("@/hooks/use-entitlement", () => ({ useEntitlement: () => entitlement }));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { CodaPanel, useCodaSettings } = await import("./settings");

afterEach(cleanup);
beforeEach(() => {
  entitlement.loading = false;
  entitlement.entitled = true;
});

const CONFIGURED = {
  codaDocId: "doc-1",
  codaTableId: "Tasks",
  codaHost: "https://coda.io",
  codaTokenSet: true,
} as unknown as ApiProject;

function Inner({ project }: { project: ApiProject }) {
  const coda = useCodaSettings({ project, replaceAndReturn: vi.fn(), fail: vi.fn() });
  return <CodaPanel projectId="p1" project={project} coda={coda} replaceProject={vi.fn()} fail={vi.fn()} />;
}

function Panel({ project }: { project: ApiProject }) {
  return (
    <SettingsProvider register={vi.fn()} unregister={vi.fn()}>
      <Inner project={project} />
    </SettingsProvider>
  );
}

describe("CodaPanel", () => {
  it("is the form with its sync button on a Pro instance", () => {
    render(<Panel project={CONFIGURED} />);

    expect(screen.getByLabelText("Doc ID")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync tasks now" })).toBeTruthy();
    expect(screen.queryByTestId("pro-upsell")).toBeNull();
  });

  it("is an upsell with the kept settings read-only on a free instance, and nothing to type or press", () => {
    entitlement.entitled = false;

    const { container } = render(<Panel project={CONFIGURED} />);

    expect(screen.getByTestId("pro-upsell").textContent).toContain("Coda sync");
    expect(screen.getByRole("link", { name: "Try Pro free for 30 days" }).getAttribute("href")).toBe(
      "https://board-planner.com/trial/"
    );
    expect(screen.getByTestId("coda-kept").textContent).toContain("doc-1");
    expect(container.querySelectorAll("input, button")).toHaveLength(0);
  });

  it("does not list settings a free board never had", () => {
    entitlement.entitled = false;

    render(<Panel project={{} as ApiProject} />);

    expect(screen.getByTestId("pro-upsell")).toBeTruthy();
    expect(screen.queryByTestId("coda-kept")).toBeNull();
  });

  it("shows neither while the plan is still being read, so a Pro board never flashes the upsell", () => {
    entitlement.loading = true;
    entitlement.entitled = false;

    const { container } = render(<Panel project={CONFIGURED} />);

    expect(container.textContent).toBe("");
  });
});
