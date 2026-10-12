// @vitest-environment happy-dom
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import ProjectSettingsPage from "./page";
import { ApiProject } from "@/types";

const { api, search } = vi.hoisted(() => ({ api: { get: vi.fn() }, search: { value: "" } }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "TP" }),
  useSearchParams: () => new URLSearchParams(search.value),
}));
vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isAdmin: false, user: { _id: "u1" } }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/use-leave-guard", () => ({ useLeaveGuard: () => {} }));
vi.mock("@/components/settings/SettingsShell", () => ({
  scrollSettingsToTop: () => {},
  SettingsShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./sections/GeneralSection", () => ({
  GeneralSection: ({ project }: { project: ApiProject }) => <p>Showing {project.name}</p>,
}));
vi.mock("./sections/BoardSection", () => ({ BoardSection: () => <p>Board section</p> }));
vi.mock("./sections/TaskFieldsSection", () => ({ TaskFieldsSection: () => null }));
vi.mock("./sections/IntegrationsSection", () => ({ IntegrationsSection: () => null }));
vi.mock("./sections/NotificationsSection", () => ({ NotificationsSection: () => null }));
vi.mock("./sections/PmAgentSection", () => ({ PmAgentSection: () => null }));
vi.mock("./sections/WorkersSection", () => ({ WorkersSection: () => null }));
vi.mock("./sections/AuditSection", () => ({ AuditSection: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const loaded = (name: string) => ({ _id: "p1", key: "TP", name, canAdmin: true }) as ApiProject;

let projectReads: Promise<ApiProject>[] = [];
const projectReadCount = () =>
  api.get.mock.calls.filter(([url]) => url === "/api/projects/TP").length;

beforeEach(() => {
  projectReads = [];
  api.get.mockReset();
  api.get.mockImplementation((url: string) =>
    url === "/api/projects/TP" ? projectReads.shift() : new Promise(() => {})
  );
});
afterEach(cleanup);

// BP-784: under Strict Mode the mount effect reads twice, and the first answer used to land last
describe("ProjectSettingsPage project read", () => {
  it("ignores the read of a mount that was let go, even when it answers last", async () => {
    const first = deferred<ApiProject>();
    projectReads = [first.promise, Promise.resolve(loaded("Fresh"))];

    render(
      <StrictMode>
        <ProjectSettingsPage />
      </StrictMode>
    );
    expect(await screen.findByText("Showing Fresh")).toBeTruthy();
    expect(projectReadCount()).toBe(2);

    await act(async () => first.resolve(loaded("Stale")));

    expect(screen.getByText("Showing Fresh")).toBeTruthy();
    expect(screen.queryByText("Showing Stale")).toBeNull();
  });

  it("does not trade a loaded page for the failure of a read it let go", async () => {
    const first = deferred<ApiProject>();
    projectReads = [first.promise, Promise.resolve(loaded("Fresh"))];

    render(
      <StrictMode>
        <ProjectSettingsPage />
      </StrictMode>
    );
    expect(await screen.findByText("Showing Fresh")).toBeTruthy();

    await act(async () => first.reject(new Error("network")));

    expect(screen.getByText("Showing Fresh")).toBeTruthy();
    expect(screen.queryByText(/Failed to load/)).toBeNull();
  });
});

// BP-1034: the setup guide links to ?section=… on this very page, which is a soft navigation
describe("a link to another section of the page", () => {
  afterEach(() => {
    search.value = "";
  });

  it("switches to that section though the page is already showing", async () => {
    api.get.mockResolvedValue(loaded("Orbit"));
    const { rerender } = render(<ProjectSettingsPage />);
    expect(await screen.findByText("Showing Orbit")).toBeTruthy();

    search.value = "section=board";
    rerender(<ProjectSettingsPage />);

    await act(async () => {});
    expect(screen.getByText("Board section").parentElement!.className).not.toContain("hidden");
    expect(screen.getByText("Showing Orbit").parentElement!.className).toContain("hidden");
  });
});
