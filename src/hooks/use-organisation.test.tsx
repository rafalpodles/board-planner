// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useOrganisation } from "@/hooks/use-organisation";

const { api, auth } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn() },
  auth: { user: null as { _id: string } | null },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));

function Probe() {
  const { organisation, failed } = useOrganisation();
  return <span data-testid="name">{failed ? "failed" : organisation?.name ?? "none"}</span>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useOrganisation (BP-920)", () => {
  it("keeps the next person's organisation when the previous person's read answers late", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    api.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    auth.user = { _id: "a" };
    const view = render(<Probe />);
    auth.user = { _id: "b" };
    view.rerender(<Probe />);

    await act(async () => second.resolve({ name: "Globex" }));
    await act(async () => first.resolve({ name: "Acme" }));

    expect(screen.getByTestId("name").textContent).toBe("Globex");
  });

  it("shows nobody's organisation before anybody is signed in, and asks for nothing", () => {
    auth.user = null;
    render(<Probe />);

    expect(screen.getByTestId("name").textContent).toBe("none");
    expect(api.get).not.toHaveBeenCalled();
  });
});
