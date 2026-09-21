// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { useEntitlement } from "@/hooks/use-entitlement";

const { api } = vi.hoisted(() => ({ api: { get: vi.fn() } }));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));

function Probe({ feature }: { feature: "integrations.coda" | "ai.byok" }) {
  const { loading, entitled } = useEntitlement(feature);
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="entitled">{String(entitled)}</span>
    </div>
  );
}

beforeEach(() => {
  api.get.mockReset();
});

afterEach(cleanup);

describe("useEntitlement", () => {
  it("starts loading, then reports the verdict for a feature the tenant has", async () => {
    let resolve: (value: unknown) => void = () => {};
    api.get.mockReturnValue(new Promise((r) => (resolve = r)));

    render(<Probe feature="integrations.coda" />);
    expect(screen.getByTestId("loading").textContent).toBe("true");

    resolve({ plan: "free", features: ["integrations.coda"], expiresAt: null });

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("entitled").textContent).toBe("true");
  });

  it("reports not entitled for a feature the tenant lacks", async () => {
    api.get.mockResolvedValue({ plan: "free", features: [], expiresAt: null });

    render(<Probe feature="integrations.coda" />);

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("entitled").textContent).toBe("false");
  });

  it("a pro plan grants a feature not explicitly listed", async () => {
    api.get.mockResolvedValue({ plan: "pro", features: [], expiresAt: null });

    render(<Probe feature="ai.byok" />);

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("entitled").textContent).toBe("true");
  });

  it("is not entitled when the request fails", async () => {
    api.get.mockRejectedValue(new Error("boom"));

    render(<Probe feature="integrations.coda" />);

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("entitled").textContent).toBe("false");
  });

  it("the verdict changes when the tenant's entitlements change between reads", async () => {
    api.get.mockResolvedValue({ plan: "free", features: [], expiresAt: null });
    const first = render(<Probe feature="integrations.coda" />);
    await waitFor(() => expect(screen.getByTestId("entitled").textContent).toBe("false"));
    first.unmount();

    api.get.mockResolvedValue({ plan: "pro", features: [], expiresAt: null });
    render(<Probe feature="integrations.coda" />);
    await waitFor(() => expect(screen.getByTestId("entitled").textContent).toBe("true"));
  });
});
