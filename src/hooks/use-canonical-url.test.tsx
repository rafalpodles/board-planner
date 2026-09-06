// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useCanonicalUrl } from "./use-canonical-url";

const route = { pathname: "/", params: {} as Record<string, string> };
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => route.params,
  usePathname: () => route.pathname,
  useRouter: () => ({ replace }),
}));

function Probe({ projectKey, taskNumber }: { projectKey?: string; taskNumber?: number }) {
  useCanonicalUrl(projectKey, taskNumber);
  return null;
}

const OBJECT_ID = "6a720d2713f137f4aebe093e";
const TASK_OBJECT_ID = "6a720d2713f137f4aebe094c";

beforeEach(() => {
  replace.mockClear();
});

afterEach(cleanup);

function at(pathname: string, params: Record<string, string>) {
  route.pathname = pathname;
  route.params = params;
  window.history.replaceState(null, "", pathname);
}

describe("useCanonicalUrl", () => {
  it("rewrites an ObjectId task URL to keys without a client-side navigation", () => {
    at(`/projects/${OBJECT_ID}/tasks/${TASK_OBJECT_ID}`, {
      projectId: OBJECT_ID,
      taskId: TASK_OBJECT_ID,
    });

    render(<Probe projectKey="RP" taskNumber={1} />);

    expect(window.location.pathname).toBe("/projects/RP/tasks/1");
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps the query and hash", () => {
    at(`/projects/${OBJECT_ID}`, { projectId: OBJECT_ID });
    window.history.replaceState(null, "", `/projects/${OBJECT_ID}?tab=list#top`);

    render(<Probe projectKey="RP" />);

    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/projects/RP?tab=list#top"
    );
  });

  it("leaves an already canonical URL alone", () => {
    at("/projects/RP/tasks/1", { projectId: "RP", taskId: "1" });
    const spy = vi.spyOn(window.history, "replaceState");

    render(<Probe projectKey="RP" taskNumber={1} />);

    expect(spy).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
