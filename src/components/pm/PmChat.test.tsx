// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hosted = vi.hoisted(() => ({ cloud: false }));
vi.mock("@/hooks/use-organisation", () => ({ useOrganisation: () => ({ organisation: { cloud: hosted.cloud } }) }));
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { PmChat } from "./PmChat";

/**
 * BP-552. The stream's `error` event writes the failure banner — and the Retry beside it — from
 * inside the read loop, before `working` is cleared. `send` refuses to run while `working`, so a
 * click in that window cleared the banner, hid the button, and sent nothing: no message, no
 * affordance, no request. It made `e2e/pm-chat.spec.ts:462` fail about one run in eight.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(), upload: vi.fn(), stream: vi.fn() },
}));

vi.mock("@/hooks/use-api", () => ({ useApi: () => api }));
vi.mock("@/hooks/use-open-task", () => ({ useOpenTask: () => vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isAdmin: true, user: { username: "member" } }) }));
vi.mock("@/lib/board-refresh", () => ({ emitBoardRefresh: vi.fn(), subscribeBoardRefresh: () => () => {} }));
vi.mock("@/hooks/use-poll-while-visible", () => ({ usePollWhileVisible: () => {} }));
const media = vi.hoisted(() => ({ wide: true }));
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => media.wide }));
// happy-dom has no canvas, and the real one would reject the one-byte file below
vi.mock("@/lib/image-resize", () => ({
  downscaleImage: (file: File) => Promise.resolve({ file, width: 10, height: 10 }),
  estimateImageTokens: () => 100,
}));

const PROJECT = {
  _id: "p1",
  key: "BP",
  name: "Board",
  pmAvailable: true,
  pm: { enabled: true, lockedByInstance: false },
};

/** An SSE body the test feeds a line at a time, and closes when it chooses */
function heldStream() {
  let push!: (line: string) => void;
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      push = (line) => controller.enqueue(encoder.encode(line));
      close = () => controller.close();
    },
  });
  return { response: new Response(body, { status: 200 }), push, close };
}

beforeEach(() => {
  vi.clearAllMocks();
  media.wide = true;
  api.get.mockImplementation((path: string) =>
    path.includes("/pm/messages")
      ? Promise.resolve({ messages: [], nextCursor: null })
      : path.includes("/tasks")
        ? Promise.resolve([])
        : Promise.resolve(PROJECT)
  );
});
afterEach(cleanup);

async function chatWithAFailedTurn() {
  const stream = heldStream();
  api.stream.mockResolvedValue(stream.response);

  render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
  const box = await screen.findByRole("textbox");

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      box,
      "Once more with feeling."
    );
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    screen.getByRole("button", { name: /send/i }).click();
  });

  // The route sends `error` and closes in the same breath, so the window is not an open stream —
  // it is the message reload that follows, which `working` outlives
  let releaseReload!: () => void;
  const reload = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  api.get.mockImplementation((path: string) =>
    path.includes("/pm/messages")
      ? reload.then(() => ({ messages: [], nextCursor: null }))
      : path.includes("/tasks")
        ? Promise.resolve([])
        : Promise.resolve(PROJECT)
  );

  await act(async () => {
    stream.push(`event: error\ndata: ${JSON.stringify({ error: "OpenRouter HTTP 500" })}\n\n`);
    stream.close();
    await Promise.resolve();
  });
  return { ...stream, releaseReload };
}

describe("Retry after a failed turn", () => {
  it("is not offered while the turn that failed is still finishing", async () => {
    const turn = await chatWithAFailedTurn();

    await waitFor(() => expect(screen.getByText("OpenRouter HTTP 500")).toBeTruthy());
    expect(
      screen.queryByRole("button", { name: "Retry" }),
      "the banner is up, but the turn has not let go"
    ).toBeNull();

    await act(async () => {
      turn.releaseReload();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
  });

  it("sends when it is pressed", async () => {
    const turn = await chatWithAFailedTurn();
    await act(async () => {
      turn.releaseReload();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());

    const before = api.stream.mock.calls.length;
    api.stream.mockResolvedValue(heldStream().response);
    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
    });

    expect(api.stream.mock.calls.length, "the retry reached the server").toBe(before + 1);
    expect(screen.queryByText("OpenRouter HTTP 500"), "and cleared the banner").toBeNull();
  });

  /**
   * The same dead button through the other half of `send`'s guard. The order matters: attaching
   * clears the banner on the way in, so the image has to be picked up *during* the turn — then the
   * turn errors and writes the banner back while the upload is still in flight.
   */
  it("is not offered while an attachment is still uploading", async () => {
    const stream = heldStream();
    api.stream.mockResolvedValue(stream.response);
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const box = await screen.findByRole("textbox");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        box,
        "Once more with feeling."
      );
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: /send/i }).click();
    });

    // Mid-turn, and the upload is held open
    let releaseUpload!: () => void;
    api.upload.mockReturnValue(
      new Promise((resolve) => {
        releaseUpload = () => resolve({ fileId: "f1" });
      })
    );
    await act(async () => {
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(input, "files", {
        value: [new File(["x"], "shot.png", { type: "image/png" })],
        configurable: true,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      stream.push(`event: error\ndata: ${JSON.stringify({ error: "OpenRouter HTTP 500" })}\n\n`);
      stream.close();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText("OpenRouter HTTP 500")).toBeTruthy());
    expect(
      screen.queryByRole("button", { name: "Retry" }),
      "the upload has not finished, so send would refuse"
    ).toBeNull();

    await act(async () => {
      releaseUpload();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
  });
});

describe("a board the reader cannot open", () => {
  it("says so, rather than blaming the server's configuration", async () => {
    api.get.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    render(<PmChat projectId="p1" />);

    expect(await screen.findByText("We couldn’t find this page. The link may have changed, or this page may not be available to you.")).toBeTruthy();
    expect(screen.queryByText(/not configured on the server/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

// BP-652
describe("a PM page where the key is the problem", () => {
  it("offers a Free organisation its own key or Pro, instead of a composer or a server setting", async () => {
    render(<PmChat projectId="p1" preloadedProject={{ ...PROJECT, pmAvailable: false, pmNeedsPlan: true } as never} />);

    expect((await screen.findByTestId("ai-needs-key")).textContent).toMatch(/The PM agent runs on your own OpenRouter key on the Free plan/);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/OPENROUTER_API_KEY/)).toBeNull();
  });

  it("says the operator has switched its key off, with the own key as the way on, instead of a composer that would be refused", async () => {
    render(<PmChat projectId="p1" preloadedProject={{ ...PROJECT, pmAvailable: false, pmLocked: true } as never} />);

    expect((await screen.findByTestId("ai-locked")).textContent).toMatch(/The PM agent is switched off for this organisation by the operator/);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByTestId("ai-needs-key")).toBeNull();
  });

  it("says a stored key that cannot be read has to be entered again, not that the server has none", async () => {
    render(<PmChat projectId="p1" preloadedProject={{ ...PROJECT, pmAvailable: false, pmKeyUnreadable: true } as never} />);

    expect((await screen.findByTestId("ai-key-unreadable")).textContent).toMatch(/stored AI key cannot be read/);
    expect(screen.queryByText(/OPENROUTER_API_KEY/)).toBeNull();
  });

  it("still blames the server's configuration when nothing says otherwise", async () => {
    render(<PmChat projectId="p1" preloadedProject={{ ...PROJECT, pmAvailable: false } as never} />);

    expect(await screen.findByText(/OPENROUTER_API_KEY missing/)).toBeTruthy();
  });
});

describe("a turn the server refuses because of the key", () => {
  async function sendRefused(status: number, body: Record<string, unknown>) {
    api.stream.mockResolvedValue(new Response(JSON.stringify(body), { status }));
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const box = await screen.findByRole("textbox");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Hello");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: /send/i }).click();
    });
  }

  it("shows the server's words for a plan refusal", async () => {
    await sendRefused(402, { error: "On the Free plan the AI runs on your own key.", reason: "needs_plan" });

    expect(await screen.findByText("On the Free plan the AI runs on your own key.")).toBeTruthy();
  });

  it("shows the server's words for a key that cannot be read, where it used to say the server has none", async () => {
    await sendRefused(503, { error: "The stored AI key cannot be read. Enter it again in Settings → AI key.", reason: "own_key_unreadable" });

    expect(await screen.findByText(/Enter it again in Settings/)).toBeTruthy();
    expect(screen.queryByText(/OPENROUTER_API_KEY missing/)).toBeNull();
  });

  it("shows the operator's words for a key it switched off, and offers no Retry for what will not lift by itself", async () => {
    await sendRefused(403, { error: "AI is switched off for this organisation by the operator: abuse report 17.", reason: "ai_locked" });

    expect(await screen.findByText(/switched off for this organisation by the operator: abuse report 17/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers a Retry for a refusal that is about the moment, such as another turn running", async () => {
    await sendRefused(409, { error: "Someone is already talking to the PM agent on this project — try again in a moment" });

    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says what the server says for an instance with no key at all", async () => {
    await sendRefused(503, { error: "PM agent is not configured (OPENROUTER_API_KEY missing)", reason: "not_configured" });

    expect(await screen.findByText(/PM agent is not configured \(OPENROUTER_API_KEY missing\)/)).toBeTruthy();
  });

  // BP-922. Every 503 used to be read as a missing key, an outage included
  it("says what the server says for a 503 that is an outage, and does not blame a key", async () => {
    await sendRefused(503, { error: "Database unavailable" });

    expect(await screen.findByText("Database unavailable")).toBeTruthy();
    expect(screen.queryByText(/OPENROUTER_API_KEY/)).toBeNull();
  });

  it("falls back to wording an organisation's admin can act on when a 503 says nothing", async () => {
    hosted.cloud = true;
    try {
      await sendRefused(503, {});

      expect(await screen.findByText(/The PM agent is unavailable right now/)).toBeTruthy();
      expect(screen.queryByText(/OPENROUTER_API_KEY/)).toBeNull();
    } finally {
      hosted.cloud = false;
    }
  });
});

describe("a PM page that could not read its board", () => {
  it("reads it again on Retry, and opens once it can", async () => {
    let fail = true;
    api.get.mockImplementation((path: string) => {
      if (path.includes("/pm/messages")) return Promise.resolve({ messages: [], nextCursor: null });
      if (path.includes("/tasks")) return Promise.resolve([]);
      return fail ? Promise.reject(Object.assign(new Error("boom"), { status: 500 })) : Promise.resolve(PROJECT);
    });
    render(<PmChat projectId="p1" />);

    const retry = await screen.findByRole("button", { name: "Retry" });
    fail = false;
    await act(async () => retry.click());

    expect(await screen.findByRole("textbox")).toBeTruthy();
  });
});

// BP-787
describe("loading older messages", () => {
  const id = (n: number) => n.toString(16).padStart(24, "0");
  const page = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      _id: id(from + i),
      project: "p1",
      role: "user",
      content: `message ${from + i}`,
      actions: [],
      attachments: [],
      trigger: { type: "chat" },
      triggeredBy: null,
      createdAt: new Date(0).toISOString(),
    }));

  function serve(older: () => Promise<unknown>) {
    api.get.mockImplementation((path: string) =>
      path.includes("before=")
        ? older()
        : path.includes("/pm/messages")
          ? Promise.resolve({ messages: page(51, 100), nextCursor: id(51) })
          : path.includes("/tasks")
            ? Promise.resolve([])
            : Promise.resolve(PROJECT)
    );
  }

  const olderRequests = () => api.get.mock.calls.filter(([path]) => String(path).includes("before=")).length;

  it("asks once and shows the page once when the button is clicked twice", async () => {
    let release!: () => void;
    serve(() => new Promise((resolve) => (release = () => resolve({ messages: page(1, 50), nextCursor: null }))));
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const button = await screen.findByRole("button", { name: "Load older messages" });

    await act(async () => {
      button.click();
      button.click();
    });
    await act(async () => {
      release();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText("message 1")).toBeTruthy());
    expect(olderRequests()).toBe(1);
    expect(screen.getAllByText("message 1")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull();
  });

  it("says so when the older page cannot be read, and lets the reader try again", async () => {
    serve(() => Promise.reject(new Error("boom")));
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const button = await screen.findByRole("button", { name: "Load older messages" });

    await act(async () => button.click());

    expect(await screen.findByText("Could not load older messages.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load older messages" })).toBeTruthy();
  });

  it("leaves the reader where they were rather than scrolling to the bottom", async () => {
    serve(() => Promise.resolve({ messages: page(1, 50), nextCursor: null }));
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const button = await screen.findByRole("button", { name: "Load older messages" });
    // The first page's scroll is a passive effect, which can still be pending when the button shows
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    const before = scroll.mock.calls.length;

    await act(async () => button.click());
    await waitFor(() => expect(screen.getByText("message 1")).toBeTruthy());

    expect(scroll.mock.calls.length).toBe(before);
    scroll.mockRestore();
  });

  it("keeps the older page when the newest page is read again", async () => {
    serve(() => Promise.resolve({ messages: page(1, 50), nextCursor: null }));
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const button = await screen.findByRole("button", { name: "Load older messages" });
    await act(async () => button.click());
    await waitFor(() => expect(screen.getByText("message 1")).toBeTruthy());

    api.get.mockImplementation((path: string) =>
      path.includes("/pm/messages")
        ? Promise.resolve({ messages: page(52, 101), nextCursor: id(52) })
        : path.includes("/tasks")
          ? Promise.resolve([])
          : Promise.resolve(PROJECT)
    );
    api.stream.mockResolvedValue(new Response("event: done\ndata: {}\n\n", { status: 200 }));
    const box = screen.getByRole("textbox");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "one more");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => screen.getByRole("button", { name: /send/i }).click());

    await waitFor(() => expect(screen.getByText("message 101")).toBeTruthy());
    expect(screen.getByText("message 1"), "the page read earlier is still there").toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull();
  });
});

describe("the composer's placeholder (BP-817)", () => {
  it("keeps the keyboard hints where there is room for them", async () => {
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    expect(await screen.findByRole("textbox")).toHaveProperty(
      "placeholder",
      "Message the PM… (Enter sends, Shift+Enter for a new line, paste to attach)"
    );
  });

  it("drops them below sm, keeping the paste hint", async () => {
    media.wide = false;
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    expect(await screen.findByRole("textbox")).toHaveProperty(
      "placeholder",
      "Message the PM… (paste to attach)"
    );
  });
});

describe("Task chips", () => {
  it("map keys from archived tasks too, so a mention of one still links", async () => {
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    await screen.findByRole("textbox");

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("/api/projects/p1/tasks?archived=include")
    );
    expect(api.get).not.toHaveBeenCalledWith("/api/projects/p1/tasks");
  });
});

// BP-942: AI Act art. 50(1) — a person talking to the PM is told it is an AI, before and during the talk
describe("who is answering", () => {
  it("says before the first message that the PM agent is an AI model", async () => {
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);

    expect(await screen.findByText(/The PM agent is an AI model, not a person, and its answers can be wrong\./)).toBeTruthy();
  });

  it("marks every answer as the AI's, and none of the reader's own messages", async () => {
    api.get.mockImplementation((path: string) =>
      path.includes("/pm/messages")
        ? Promise.resolve({
            messages: [
              { _id: "m1", project: "p1", role: "user", content: "Plan the release", actions: [], trigger: { type: "chat" }, triggeredBy: null, createdAt: "2026-10-10T10:00:00Z" },
              { _id: "m2", project: "p1", role: "assistant", content: "Here is a plan", actions: [], trigger: { type: "chat" }, triggeredBy: null, createdAt: "2026-10-10T10:00:05Z" },
            ],
            nextCursor: null,
          })
        : path.includes("/tasks")
          ? Promise.resolve([])
          : Promise.resolve(PROJECT)
    );
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);

    await screen.findByText("Here is a plan");
    const badges = screen.getAllByTestId("ai-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].parentElement!.textContent).toContain("PM Agent");
  });
});

describe("a turn still running", () => {
  it("is marked as the AI's while it works", async () => {
    const stream = heldStream();
    api.stream.mockResolvedValue(stream.response);
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const box = await screen.findByRole("textbox");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Plan it.");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: /send/i }).click();
    });

    // An empty thread before the send, so the one badge is the running turn's
    const badge = await screen.findByTestId("ai-badge");
    expect(badge.parentElement!.querySelector(".animate-spin")).toBeTruthy();
    stream.close();
  });
});

describe("a turn that streams its answer (BP-1037)", () => {
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

  async function startTurn() {
    const stream = heldStream();
    api.stream.mockResolvedValue(stream.response);
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const box = await screen.findByRole("textbox");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Plan it.");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: /send/i }).click();
    });
    return stream;
  }

  it("shows the text as it arrives, a piece at a time", async () => {
    const stream = await startTurn();

    await act(async () => stream.push(event("round", {}) + event("delta", { text: "Here is " })));
    expect((await screen.findByTestId("pm-live-text")).textContent).toBe("Here is");

    await act(async () => stream.push(event("delta", { text: "the plan." })));
    expect(screen.getByTestId("pm-live-text").textContent).toBe("Here is the plan.");
    await act(async () => stream.close());
  });

  it("marks the reader's own mention in the text as it arrives", async () => {
    api.get.mockImplementation((path: string) =>
      path.includes("/pm/messages")
        ? Promise.resolve({ messages: [], nextCursor: null })
        : path.includes("/assignable-users")
          ? Promise.resolve([
              { _id: "u1", username: "member", fullName: "Mia Member" },
              { _id: "u2", username: "owner", fullName: "Olga Owner" },
            ])
          : path.includes("/tasks")
            ? Promise.resolve([])
            : Promise.resolve(PROJECT)
    );
    const stream = await startTurn();

    await act(async () => stream.push(event("delta", { text: "Ask @member or @owner." })));
    const live = await screen.findByTestId("pm-live-text");
    await waitFor(() => expect(live.querySelectorAll("span.mention")).toHaveLength(2));
    expect([...live.querySelectorAll("span.mention")].map((el) => [el.textContent, el.classList.contains("mention-self")])).toEqual([
      ["@Mia Member", true],
      ["@Olga Owner", false],
    ]);
    await act(async () => stream.close());
  });

  it("starts the text again when the agent makes another call, because only the last call's text is the answer", async () => {
    const stream = await startTurn();

    await act(async () => stream.push(event("delta", { text: "Let me look." })));
    expect((await screen.findByTestId("pm-live-text")).textContent).toBe("Let me look.");
    await act(async () => stream.push(event("round", {})));

    expect(screen.queryByTestId("pm-live-text")).toBeNull();
    await act(async () => stream.close());
  });

  it("drops the text in front of a tool call as soon as the call begins, since it cannot be the answer", async () => {
    const stream = await startTurn();

    await act(async () => stream.push(event("delta", { text: "I will add that." })));
    expect(await screen.findByTestId("pm-live-text")).toBeTruthy();
    await act(async () => stream.push(event("tool", { tool: "create_task", phase: "preparing" })));

    expect(screen.queryByTestId("pm-live-text")).toBeNull();
    await act(async () => stream.close());
  });

  it("keeps saying Stopping… while the stream goes on until the abort lands", async () => {
    api.post.mockResolvedValue({});
    const stream = await startTurn();
    await act(async () => stream.push(event("delta", { text: "Writing" })));

    await act(async () => {
      screen.getByRole("button", { name: "Stop the PM turn" }).click();
    });
    expect(screen.getByRole("status").textContent).toBe("Stopping…");
    await act(async () => stream.push(event("delta", { text: " more" }) + event("tool", { tool: "list_tasks", phase: "running" })));

    expect(screen.getByRole("status").textContent).toBe("Stopping…");
    await act(async () => stream.close());
  });

  it("does not announce each chunk of the answer to a screen reader", async () => {
    const stream = await startTurn();

    await act(async () => stream.push(event("delta", { text: "Writing" })));
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("off");

    await act(async () => stream.push(event("tool", { tool: "create_task", phase: "preparing" })));
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    await act(async () => stream.close());
  });

  it("says which tool the agent is preparing and then running", async () => {
    const stream = await startTurn();

    await act(async () => stream.push(event("tool", { tool: "create_task", phase: "preparing" })));
    expect(screen.getByRole("status").textContent).toBe("Preparing a new task…");

    await act(async () => stream.push(event("tool", { tool: "create_task", phase: "running" })));
    expect(screen.getByRole("status").textContent).toBe("Applying a new task…");
    await act(async () => stream.close());
  });

  it("keeps the text it had on screen under the recovery notice when the stream drops", async () => {
    const stream = await startTurn();
    await act(async () => stream.push(event("delta", { text: "Half an ans" })));

    await act(async () => stream.close());

    expect(await screen.findByText(/Connection lost/)).toBeTruthy();
    expect(screen.getByTestId("pm-live-text").textContent).toBe("Half an ans");
  });
});

/**
 * BP-1029. "PM is thinking…" and Stop appear before the send has reached the server's lock, and a
 * Stop pressed then was answered "no turn is running", read as "it finished on its own", and
 * dropped: the composer stayed on "Stopping…" while the turn started and ran to the end.
 */
describe("a Stop pressed before the server has taken the turn", () => {
  const NO_TURN = Object.assign(new Error("No PM turn is running for this project"), {
    status: 404,
    body: { error: "No PM turn is running for this project" },
  });
  const stopButton = () => screen.getByRole("button", { name: /stop the pm turn/i });
  const interrupts = () =>
    api.post.mock.calls.filter(([path]) => String(path).endsWith("/pm/interrupt")).length;

  /** A send whose answer the test holds back until it chooses */
  async function sendHeld() {
    let answer!: (response: Response) => void;
    api.stream.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const box = await screen.findByRole("textbox");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Never mind.");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: /send/i }).click();
    });
    return { answer };
  }

  it("is asked again the moment the send is answered, and then reaches the turn", async () => {
    const { answer } = await sendHeld();
    api.post.mockRejectedValueOnce(NO_TURN).mockResolvedValue({ interrupted: true });

    await act(async () => stopButton().click());
    expect(interrupts(), "asked once, and told there is no turn yet").toBe(1);
    expect(screen.getByText("Stopping…")).toBeTruthy();

    await act(async () => {
      answer(heldStream().response);
      await Promise.resolve();
    });

    await waitFor(() => expect(interrupts(), "asked again once the lock is held").toBe(2));
  });

  it("does not ask again for a turn that was already running and has finished", async () => {
    const turn = heldStream();
    api.stream.mockResolvedValue(turn.response);
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const box = await screen.findByRole("textbox");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Never mind.");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: /send/i }).click();
    });
    await screen.findByRole("button", { name: /stop the pm turn/i });
    api.post.mockRejectedValue(NO_TURN);

    await act(async () => stopButton().click());
    await act(async () => {
      await Promise.resolve();
    });

    expect(interrupts(), "the turn was held and is gone: nothing left to stop").toBe(1);
  });

  it("asks again when the answer to the send came while the first Stop was in flight", async () => {
    const { answer } = await sendHeld();
    let tooLate!: (error: Error) => void;
    api.post
      .mockReturnValueOnce(new Promise((_, reject) => (tooLate = reject)))
      .mockResolvedValue({ interrupted: true });

    await act(async () => stopButton().click());
    // The server took the lock between looking and answering: the 404 is already stale
    await act(async () => {
      answer(heldStream().response);
      await Promise.resolve();
    });
    await act(async () => {
      tooLate(NO_TURN);
      await Promise.resolve();
    });

    await waitFor(() => expect(interrupts()).toBe(2));
  });

  it("does not stop the next turn with a Stop that was answered after its own send was refused", async () => {
    const first = await sendHeld();
    let late!: (error: Error) => void;
    api.post.mockReturnValueOnce(new Promise((_, reject) => (late = reject)));
    await act(async () => stopButton().click());
    // Refused first, and only then does the server's "no turn" reach the browser
    await act(async () => {
      first.answer(new Response(JSON.stringify({ error: "Someone is already talking" }), { status: 409 }));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByText("Stopping…")).toBeNull());
    await act(async () => {
      late(NO_TURN);
      await Promise.resolve();
    });

    api.stream.mockResolvedValue(heldStream().response);
    const box = screen.getByRole("textbox");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Another try.");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: /send/i }).click();
    });
    await screen.findByRole("button", { name: /stop the pm turn/i });

    expect(interrupts(), "the old Stop was not applied to a turn nobody stopped").toBe(1);
  });

  it("leaves no \"Stopping…\" behind when the send is refused", async () => {
    const { answer } = await sendHeld();
    api.post.mockRejectedValue(NO_TURN);
    await act(async () => stopButton().click());
    expect(screen.getByText("Stopping…")).toBeTruthy();

    await act(async () => {
      answer(
        new Response(JSON.stringify({ error: "Someone is already talking to the PM agent" }), { status: 409 })
      );
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByText("Stopping…")).toBeNull());
    expect(interrupts(), "a refused send has no turn to stop").toBe(1);
    expect(screen.getByRole("button", { name: /send/i })).toBeTruthy();
  });
});

describe("mentions in the composer (BP-1106)", () => {
  beforeEach(() => {
    api.get.mockImplementation((path: string) =>
      path.includes("/pm/messages")
        ? Promise.resolve({ messages: [], nextCursor: null })
        : path.includes("/assignable-users")
          ? Promise.resolve([{ _id: "u1", username: "member", fullName: "Mia Member" }])
          : path.includes("/tasks/suggest")
            ? Promise.resolve([{ _id: "t7", taskNumber: 7, title: "Fix the login" }])
            : path.includes("/tasks")
              ? Promise.resolve([])
              : Promise.resolve(PROJECT)
    );
  });

  async function typeInto(box: HTMLTextAreaElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
      box.selectionStart = box.selectionEnd = value.length;
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("offers the board's people after @, and Enter picks one without sending", async () => {
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/projects/p1/assignable-users"));

    await typeInto(box, "ask @mem");
    const option = await screen.findByRole("option", { name: /member/ });
    expect(option.textContent).toContain("Mia Member");

    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(box.value).toBe("ask @member "));
    expect(api.stream).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("offers the board's tasks after its key, and Tab inserts the key", async () => {
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;

    await typeInto(box, "look at BP-");
    await screen.findByRole("option", { name: /BP-7/ });
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(box.value).toBe("look at BP-7 "));
  });

  it("closes on Escape and leaves what was typed", async () => {
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/projects/p1/assignable-users"));

    await typeInto(box, "ask @mem");
    await screen.findByRole("listbox");
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box.value).toBe("ask @mem");
  });

  it("does not open a list that arrives after the message was sent", async () => {
    let answer!: (tasks: unknown[]) => void;
    api.get.mockImplementation((path: string) =>
      path.includes("/pm/messages")
        ? Promise.resolve({ messages: [], nextCursor: null })
        : path.includes("/tasks/suggest")
          ? new Promise((resolve) => (answer = resolve))
          : path.includes("/tasks")
            ? Promise.resolve([])
            : path.includes("/assignable-users")
              ? Promise.resolve([])
              : Promise.resolve(PROJECT)
    );
    api.stream.mockResolvedValue(heldStream().response);
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;

    await typeInto(box, "see BP-1");
    await waitFor(() => expect(answer).toBeTypeOf("function"));
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(api.stream).toHaveBeenCalled());

    await act(async () => answer([{ _id: "t1", taskNumber: 12, title: "Late" }]));

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("still sends on Enter when nothing is offered", async () => {
    api.stream.mockResolvedValue(heldStream().response);
    render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;

    await typeInto(box, "hello");
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(api.stream).toHaveBeenCalled());
  });

  it("shows a mention of the board's people in the thread as a pill", async () => {
    api.get.mockImplementation((path: string) =>
      path.includes("/pm/messages")
        ? Promise.resolve({
            messages: [
              { _id: "m1", project: "p1", role: "user", content: "assign it to @member", actions: [], trigger: { type: "chat" }, triggeredBy: null, createdAt: "2026-10-10T10:00:00Z" },
            ],
            nextCursor: null,
          })
        : path.includes("/assignable-users")
          ? Promise.resolve([{ _id: "u1", username: "member", fullName: "Mia Member" }])
          : path.includes("/tasks")
            ? Promise.resolve([])
            : Promise.resolve(PROJECT)
    );
    const { container } = render(<PmChat projectId="p1" preloadedProject={PROJECT as never} />);

    await waitFor(() => expect(container.querySelector("span.mention")?.textContent).toBe("@Mia Member"));
    expect(container.querySelector("span.mention")?.getAttribute("title")).toBe("@member");
    expect(container.querySelector("span.mention")?.classList.contains("mention-self")).toBe(true);
  });
});
