// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TokenRejectedBanner } from "./TokenRejectedBanner";
import type { ApiProject } from "@/types";

afterEach(cleanup);

const rejected = { rejectedAt: `${new Date().getFullYear()}-10-18T12:00:00Z`, login: "", expiresAt: null, lastSyncAt: null, lastSyncLinked: 0, lastSyncTasks: 0, expiryNotifiedFor: null };
const project = (over: Partial<ApiProject> = {}) =>
  ({ key: "BP", canAdmin: true, githubTokenSet: true, githubConnection: rejected, ...over }) as ApiProject;

describe("the board's notice that its token was rejected (BP-1108)", () => {
  it("tells whoever can fix it, and links to the setting", () => {
    render(<TokenRejectedBanner project={project()} />);

    expect(screen.getByRole("status").textContent).toContain("Pull requests on this board stopped updating on 18 Oct: GitHub rejected the token.");
    expect(screen.getByRole("link", { name: "Fix in Settings" }).getAttribute("href")).toBe("/projects/BP/settings?section=integrations");
  });

  it("says nothing to a member who cannot change the token", () => {
    render(<TokenRejectedBanner project={project({ canAdmin: false })} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says nothing while the token works, or once it has been removed", () => {
    render(<TokenRejectedBanner project={project({ githubConnection: { ...rejected, rejectedAt: null } })} />);
    render(<TokenRejectedBanner project={project({ githubTokenSet: false })} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
