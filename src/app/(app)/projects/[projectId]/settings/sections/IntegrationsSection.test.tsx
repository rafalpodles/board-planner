// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { IntegrationsSection } from "./IntegrationsSection";
import { SettingsProvider } from "@/components/settings/settings-context";
import { ApiProject } from "@/types";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

afterEach(cleanup);

function renderSection(over: Partial<ApiProject> = {}) {
  const project = {
    _id: "p1",
    key: "TP",
    name: "Test Project",
    repositoryUrl: "",
    repositoryProvider: "",
    githubTokenSet: false,
    notificationChannels: [],
    webhooks: [],
    canAdmin: true,
    ...over,
  } as ApiProject;
  return render(
    <SettingsProvider register={vi.fn()} unregister={vi.fn()}>
      <IntegrationsSection
        projectId="p1"
        project={project}
        patchProject={vi.fn()}
        replaceProject={vi.fn()}
        isAdmin
        stats={null}
      />
    </SettingsProvider>
  );
}

const type = (value: string) =>
  fireEvent.change(screen.getByLabelText("Repository URL"), { target: { value } });

const githubRow = () => screen.queryByRole("button", { name: "Configure GitHub" });

// BP-739: the badge and the Connections list read the saved classification, so a URL was only
// recognised once it had been saved
describe("IntegrationsSection classifying the repository URL as it is typed", () => {
  it("recognises a github.com URL before it is saved, and lists its connection", () => {
    renderSection();
    expect(githubRow()).toBeNull();

    type("https://github.com/owner/repo");

    expect(screen.getByText("Recognised as GitHub, so its connection is listed below.")).toBeTruthy();
    expect(screen.queryByText("Host not recognised")).toBeNull();
    expect(githubRow()).toBeTruthy();
  });

  it("still warns about a host nobody recognises", () => {
    renderSection();

    type("https://git.unknown.example/owner/repo");

    expect(screen.getByText("Host not recognised")).toBeTruthy();
    expect(screen.getByText(/^Not a host this instance recognises/)).toBeTruthy();
    expect(githubRow()).toBeNull();
  });

  it("stops calling a saved GitHub URL GitHub once it is edited to an unknown host", () => {
    renderSection({
      repositoryUrl: "https://github.com/owner/repo",
      repositoryProvider: "github",
    });
    expect(screen.getByText("Recognised as GitHub, so its connection is listed below.")).toBeTruthy();

    type("https://git.unknown.example/owner/repo");

    expect(screen.getByText("Host not recognised")).toBeTruthy();
  });

  it("recognises this instance's own GitHub host, as the server does", () => {
    renderSection({ githubWebBase: "https://ghe.corp.example" });

    type("https://ghe.corp.example/owner/repo");

    expect(screen.getByText("Recognised as GitHub, so its connection is listed below.")).toBeTruthy();
  });

  it("recognises a self-hosted GitLab once the project names its host", () => {
    renderSection({ gitlabHost: "https://git.corp.example" });

    type("https://git.corp.example/group/thing");

    expect(screen.getByText("Recognised as GitLab, so its connection is listed below.")).toBeTruthy();
  });
});
