// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { AuthProvider } from "@/components/AuthProvider";
import { useAuth } from "@/hooks/use-auth";

const USER = { _id: "u1", username: "rpo", role: "admin" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let attempt: { username: string; password: string } = { username: "rpo", password: "pw" };

function Probe() {
  const { user, isLoading, outage, login } = useAuth();
  return (
    <div>
      <span data-testid="user">{user?.username ?? "-"}</span>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="outage">{String(outage)}</span>
      <span data-testid="reason" />
      <button
        onClick={async () => {
          const result = await login(attempt.username, attempt.password);
          const slot = document.querySelector('[data-testid="reason"]');
          if (slot) slot.textContent = result.ok ? "ok" : result.reason;
        }}
      >
        sign in
      </button>
    </div>
  );
}

async function renderSettled() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
  await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
}

describe("useAuthProvider — telling an outage from a signed-out session", () => {
  beforeEach(() => {
    attempt = { username: "rpo", password: "pw" };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("holds no user and no outage when the session is genuinely gone", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, { error: "Unauthorized" }));

    await renderSettled();

    expect(screen.getByTestId("user").textContent).toBe("-");
    expect(screen.getByTestId("outage").textContent).toBe("false");
  });

  // The pair the guard reads. `outage` is what stops it redirecting, so a 503 that only cleared the
  // user would still bounce somebody to a sign-in page that cannot sign them in (BP-362).
  it("reports an outage when the server could not answer", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(503, { error: "The database is unreachable." }));

    await renderSettled();

    expect(screen.getByTestId("user").textContent).toBe("-");
    expect(screen.getByTestId("outage").textContent).toBe("true");
  });

  it("treats a request that never completed the same way", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));

    await renderSettled();

    expect(screen.getByTestId("outage").textContent).toBe("true");
  });

  it("treats a 500 as an outage too, not as a rejected session", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(500, { error: "Internal Server Error" }));

    await renderSettled();

    expect(screen.getByTestId("outage").textContent).toBe("true");
  });

  it("clears the outage as soon as the instance answers again", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(503, { error: "down" }))
      .mockResolvedValue(jsonResponse(200, USER));

    await renderSettled();
    expect(screen.getByTestId("outage").textContent).toBe("true");

    await act(async () => {
      screen.getByText("sign in").click();
    });

    await waitFor(() => expect(screen.getByTestId("outage").textContent).toBe("false"));
    expect(screen.getByTestId("user").textContent).toBe("rpo");
  });
});

describe("useAuthProvider — what a failed sign-in says", () => {
  beforeEach(() => {
    attempt = { username: "rpo", password: "pw" };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function signIn(response: Response | Error) {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }));
    await renderSettled();

    if (response instanceof Error) vi.mocked(fetch).mockRejectedValueOnce(response);
    else vi.mocked(fetch).mockResolvedValueOnce(response);

    await act(async () => {
      screen.getByText("sign in").click();
    });
    return screen.getByTestId("reason");
  }

  it("says the instance cannot be reached, not that the password is wrong", async () => {
    const reason = await signIn(
      jsonResponse(503, { error: "The database is unreachable. This is not a problem with your session." })
    );

    await waitFor(() => expect(reason.textContent).not.toBe(""));
    expect(reason.textContent).toMatch(/database is unreachable/i);
    expect(reason.textContent).not.toMatch(/invalid credentials/i);
    expect(screen.getByTestId("outage").textContent).toBe("true");
  });

  it("passes on the lockout message instead of blaming the password", async () => {
    const reason = await signIn(
      jsonResponse(429, { error: "Too many failed attempts. Try again later." })
    );

    await waitFor(() => expect(reason.textContent).not.toBe(""));
    expect(reason.textContent).toMatch(/too many failed attempts/i);
    expect(screen.getByTestId("outage").textContent).toBe("false");
  });

  it("still says invalid credentials when that is what happened", async () => {
    const reason = await signIn(jsonResponse(401, { error: "Invalid credentials" }));

    await waitFor(() => expect(reason.textContent).not.toBe(""));
    expect(reason.textContent).toMatch(/invalid credentials/i);
    expect(screen.getByTestId("outage").textContent).toBe("false");
  });

  it("has something to say when the request never left", async () => {
    const reason = await signIn(new TypeError("Failed to fetch"));

    await waitFor(() => expect(reason.textContent).not.toBe(""));
    expect(reason.textContent).toMatch(/cannot reach the server/i);
    expect(screen.getByTestId("outage").textContent).toBe("true");
  });

  it("signs in on success", async () => {
    const reason = await signIn(jsonResponse(200, USER));

    await waitFor(() => expect(reason.textContent).toBe("ok"));
    expect(screen.getByTestId("user").textContent).toBe("rpo");
  });
});
