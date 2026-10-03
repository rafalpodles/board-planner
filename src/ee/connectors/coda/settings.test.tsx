// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApiProject } from "@/types";
import { SettingsProvider } from "@/components/settings/settings-context";

const entitlement = vi.hoisted(() => ({ loading: false, entitled: true, error: false }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/hooks/use-entitlement", () => ({ useEntitlement: () => entitlement }));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { CodaPanel, useCodaSettings } = await import("./settings");

afterEach(cleanup);
beforeEach(() => {
  Object.assign(entitlement, { loading: false, entitled: true, error: false });
  api.put.mockReset();
});

const CONFIGURED = {
  codaDocId: "doc-1",
  codaTableId: "Tasks",
  codaHost: "https://coda.io",
  codaTokenSet: true,
} as unknown as ApiProject;

const replaceProject = vi.fn();

function Inner({ project }: { project: ApiProject }) {
  const coda = useCodaSettings({ project, replaceAndReturn: vi.fn(), fail: vi.fn() });
  return <CodaPanel projectId="p1" project={project} coda={coda} replaceProject={replaceProject} fail={vi.fn()} />;
}

function Panel({ project }: { project: ApiProject }) {
  return (
    <SettingsProvider register={vi.fn()} unregister={vi.fn()}>
      <Inner project={project} />
    </SettingsProvider>
  );
}

const keptRow = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

describe("CodaPanel", () => {
  it("is the form with its sync button on a Pro instance", () => {
    render(<Panel project={CONFIGURED} />);

    expect(screen.getByLabelText("Doc ID")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync tasks now" })).toBeTruthy();
    expect(screen.queryByTestId("pro-upsell")).toBeNull();
  });

  it("is an upsell with the kept settings read-only on a free instance, and only Disconnect to press", () => {
    entitlement.entitled = false;

    const { container } = render(<Panel project={CONFIGURED} />);

    expect(screen.getByTestId("pro-upsell").textContent).toContain("Coda sync");
    expect(screen.getByRole("link", { name: /^Try Pro free for 30 days/ }).getAttribute("href")).toBe(
      "https://board-planner.com/trial/"
    );
    expect(keptRow("Doc ID")).toBe("doc-1");
    expect(keptRow("API token")).toBe("Set");
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Disconnect"]);
  });

  it("lets a free board clear its Coda settings", async () => {
    entitlement.entitled = false;
    api.put.mockResolvedValue({});

    render(<Panel project={CONFIGURED} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    expect(api.put).toHaveBeenCalledWith("/api/projects/p1", {
      codaDocId: "",
      codaTableId: "",
      codaHost: "https://coda.io",
      codaToken: "",
    });
  });

  it("counts a board with only a stored token as configured", () => {
    entitlement.entitled = false;

    render(<Panel project={{ codaTokenSet: true } as unknown as ApiProject} />);

    expect(keptRow("API token")).toBe("Set");
    expect(keptRow("Doc ID")).toBe("—");
  });

  it("does not list settings a free board never had, nor offer to disconnect them", () => {
    entitlement.entitled = false;

    const { container } = render(<Panel project={{} as ApiProject} />);

    expect(screen.getByTestId("pro-upsell")).toBeTruthy();
    expect(screen.queryByTestId("coda-kept")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("says it is checking while the plan is read, so a Pro board never flashes the upsell", () => {
    Object.assign(entitlement, { loading: true, entitled: false });

    render(<Panel project={CONFIGURED} />);

    expect(screen.getByRole("status").textContent).toContain("Checking");
    expect(screen.queryByTestId("pro-upsell")).toBeNull();
    expect(screen.queryByLabelText("Doc ID")).toBeNull();
  });

  it("says it could not check the plan instead of telling a Pro board it needs Pro", () => {
    Object.assign(entitlement, { entitled: false, error: true });

    render(<Panel project={CONFIGURED} />);

    expect(screen.getByRole("alert").textContent).toContain("Couldn't check this instance's plan");
    expect(screen.queryByTestId("pro-upsell")).toBeNull();
  });
});
