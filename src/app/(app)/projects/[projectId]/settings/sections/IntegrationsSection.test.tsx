// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { deploymentsNote, IntegrationsSection, repositoriesNote } from "./IntegrationsSection";
import { SettingsProvider } from "@/components/settings/settings-context";
import { ApiProject } from "@/types";

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), del: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

afterEach(cleanup);
// The section reads the plan for Coda (BP-651); Pro unless a test says otherwise
beforeEach(() => api.get.mockResolvedValue({ plan: "pro", features: [], expiresAt: null }));

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

const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("IntegrationsSection rows holding an unsaved edit", () => {
  it("keeps an implied GitLab row, and its Host field, while the host is edited", () => {
    renderSection({
      repositoryUrl: "https://git.corp.example/g/r",
      repositoryProvider: "gitlab",
      gitlabHost: "https://git.corp.example",
    });
    fireEvent.click(screen.getByRole("button", { name: "Configure GitLab" }));

    change("Host", "https://git.corp.exampl");

    expect(screen.getByLabelText("Host")).toHaveProperty("value", "https://git.corp.exampl");
    expect(screen.getByRole("button", { name: "Collapse GitLab" })).toBeTruthy();
    expect(screen.getByText("Recognised as GitLab, so its connection is listed below.")).toBeTruthy();
  });

  it("keeps a GitHub row with a typed token when the URL moves off GitHub, until it is removed", () => {
    renderSection();
    type("https://github.com/owner/repo");
    fireEvent.click(screen.getByRole("button", { name: "Configure GitHub" }));
    change("Access token", "ghp_unsaved");

    type("https://git.unknown.example/owner/repo");

    expect(screen.getByText("Host not recognised")).toBeTruthy();
    expect(screen.getByLabelText("Access token")).toHaveProperty("value", "ghp_unsaved");

    fireEvent.click(screen.getByRole("button", { name: "Remove GitHub" }));
    expect(screen.queryByRole("button", { name: /GitHub$/ })).toBeNull();
  });
});

describe("IntegrationsSection and a GitLab host that is not saved yet", () => {
  it("does not call a URL GitLab on the strength of a host the server may still refuse", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /^GitLab/ }));
    change("Host", "http://git.corp.example");

    type("https://git.corp.example/g/r");

    expect(screen.getByText("Host not recognised")).toBeTruthy();
    expect(screen.queryByText("Recognised as GitLab, so its connection is listed below.")).toBeNull();
  });
});

describe("IntegrationsSection and Coda on a free instance (BP-651)", () => {
  it("badges a configured Coda row Pro instead of calling it Connected", async () => {
    api.get.mockResolvedValue({ plan: "free", features: [], expiresAt: null });

    renderSection({ codaDocId: "doc-1", codaTokenSet: true } as Partial<ApiProject>);

    await waitFor(() => expect(screen.getByText("feature", { exact: false, selector: ".sr-only" })).toBeTruthy());
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("calls the same row Connected on Pro", async () => {
    renderSection({ codaDocId: "doc-1", codaTokenSet: true } as Partial<ApiProject>);
    fireEvent.click(screen.getByRole("button", { name: "Configure Coda" }));

    // The form renders only once the plan is read and is Pro, so the list below is the loaded one
    await screen.findByLabelText("Doc ID");
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByText("feature", { exact: false, selector: ".sr-only" })).toBeNull();
  });
});

// BP-1069. The repositories after the primary one, which every task of the project runs in
describe("IntegrationsSection additional repositories", () => {
  const WEB = { id: "r1", url: "https://github.com/acme/web", name: "Web" };
  const API = { id: "r2", url: "https://github.com/acme/api", name: "API" };

  function renderWith(repositories: { id: string; url: string; name: string }[]) {
    const register = vi.fn();
    const replaceProject = vi.fn();
    const project = {
      _id: "p1",
      key: "TP",
      name: "Test Project",
      repositoryUrl: repositories[0]?.url ?? "",
      repositories,
      repositoryProvider: repositories.length ? "github" : "",
      githubTokenSet: false,
      notificationChannels: [],
      webhooks: [],
      canAdmin: true,
    } as unknown as ApiProject;
    render(
      <SettingsProvider register={register} unregister={vi.fn()}>
        <IntegrationsSection projectId="p1" project={project} patchProject={vi.fn()} replaceProject={replaceProject} isAdmin stats={null} />
      </SettingsProvider>
    );
    const group = () => register.mock.calls.map(([g]) => g).filter((g) => g.id === "integrations-more-repositories").pop();
    return { group, replaceProject };
  }

  it("offers no list until there is a primary repository to follow", () => {
    renderWith([]);
    expect(screen.queryByText("Additional repositories")).toBeNull();
  });

  it("lists the repositories after the primary, each with its name and address", () => {
    renderWith([WEB, API]);

    expect((screen.getByLabelText("Additional repository 1 URL") as HTMLInputElement).value).toBe(API.url);
    expect((screen.getByLabelText("Additional repository 1 name") as HTMLInputElement).value).toBe("API");
    expect(screen.queryByLabelText("Additional repository 2 URL")).toBeNull();
  });

  it("says what a second repository changes only once there is one", () => {
    renderWith([WEB]);
    expect(screen.queryByText(/holds a checkout of every one/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add a repository" }));

    expect(screen.getByText(/holds a checkout of every one/)).toBeTruthy();
  });

  it("saves the list it shows, without the primary, and shows what the server kept", async () => {
    const { group, replaceProject } = renderWith([WEB]);
    api.put.mockResolvedValue({ _id: "p1", repositories: [WEB, API] });

    fireEvent.click(screen.getByRole("button", { name: "Add a repository" }));
    fireEvent.change(screen.getByLabelText("Additional repository 1 URL"), { target: { value: " https://github.com/acme/api " } });
    fireEvent.change(screen.getByLabelText("Additional repository 1 name"), { target: { value: "API" } });
    await waitFor(() => expect(group().count).toBe(1));
    await group().save();

    expect(api.put).toHaveBeenCalledWith("/api/projects/p1", { additionalRepositories: [{ url: "https://github.com/acme/api", name: "API" }] });
    expect(replaceProject).toHaveBeenCalled();
    await waitFor(() => expect(group().count).toBe(0));
  });

  it("does not send a row nothing was typed into", async () => {
    const { group } = renderWith([WEB]);
    api.put.mockResolvedValue({ _id: "p1", repositories: [WEB] });

    fireEvent.click(screen.getByRole("button", { name: "Add a repository" }));
    await waitFor(() => expect(group().count).toBe(1));
    await group().save();

    expect(api.put).toHaveBeenCalledWith("/api/projects/p1", { additionalRepositories: [] });
  });

  it("removes a row and saves the list without it", async () => {
    const { group } = renderWith([WEB, API]);
    api.put.mockResolvedValue({ _id: "p1", repositories: [WEB] });

    fireEvent.click(screen.getByRole("button", { name: "Remove additional repository 1" }));
    await waitFor(() => expect(group().count).toBe(1));
    await group().save();

    expect(api.put).toHaveBeenCalledWith("/api/projects/p1", { additionalRepositories: [] });
    expect(screen.queryByLabelText("Additional repository 1 URL")).toBeNull();
  });

  it("keeps what was typed and says why when the server refuses the list", async () => {
    const { group } = renderWith([WEB]);
    api.put.mockRejectedValue(new Error("additionalRepositories[0].url is already listed"));

    fireEvent.click(screen.getByRole("button", { name: "Add a repository" }));
    fireEvent.change(screen.getByLabelText("Additional repository 1 URL"), { target: { value: WEB.url } });
    await waitFor(() => expect(group().count).toBe(1));
    await group().save();

    expect(toast).toHaveBeenCalledWith("additionalRepositories[0].url is already listed", "error");
    expect((screen.getByLabelText("Additional repository 1 URL") as HTMLInputElement).value).toBe(WEB.url);
  });

  it("stops offering to add at ten repositories in all", () => {
    renderWith([WEB, ...Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, url: `https://github.com/acme/x${i}`, name: "" }))]);
    expect(screen.queryByRole("button", { name: "Add a repository" })).toBeNull();
  });
});

describe("deploymentsNote", () => {
  it("says what a manual sync did with deployments, and nothing when it did not read them", () => {
    expect(deploymentsNote(undefined)).toBe("");
    expect(deploymentsNote({ ran: true, inserted: 0, finished: 2 })).toBe("");
    expect(deploymentsNote({ ran: true, inserted: 3, finished: 0 })).toBe("; 3 new deployments read");
    expect(deploymentsNote({ ran: true, inserted: 1, finished: 0 })).toBe("; 1 new deployment read");
    expect(deploymentsNote({ ran: false, reason: "rate limited" })).toBe("; deployments wait for GitHub's rate limit");
    expect(deploymentsNote({ ran: false, reason: "failed", error: "GitHub answered 403" })).toBe(
      "; deployments could not be read: GitHub answered 403"
    );
  });
});

describe("repositoriesNote", () => {
  it("names a repository a sync could not read, and nothing when it read them all", () => {
    expect(repositoriesNote(undefined)).toBe("");
    expect(repositoriesNote([])).toBe("");
    expect(
      repositoriesNote([
        { repository: "https://github.com/acme/api", error: "GitHub answered 404" },
        { repository: "https://github.com/acme/docs", error: "no answer" },
      ])
    ).toBe("; could not read https://github.com/acme/api (GitHub answered 404), https://github.com/acme/docs (no answer)");
  });
});
