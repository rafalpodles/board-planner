// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@/lib/board-refresh", () => ({ emitBoardRefresh: vi.fn(), subscribeBoardRefresh: () => () => {} }));
vi.mock("@/hooks/use-poll-while-visible", () => ({ usePollWhileVisible: () => {} }));

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

  // The turn fails, and the stream stays open — which is the window
  await act(async () => {
    stream.push(`event: error\ndata: ${JSON.stringify({ error: "OpenRouter HTTP 500" })}\n\n`);
    await Promise.resolve();
  });
  return stream;
}

describe("Retry after a failed turn", () => {
  it("is not offered while the turn that failed is still finishing", async () => {
    const stream = await chatWithAFailedTurn();

    await waitFor(() => expect(screen.getByText("OpenRouter HTTP 500")).toBeTruthy());
    expect(
      screen.queryByRole("button", { name: "Retry" }),
      "the banner is up, but the turn has not let go"
    ).toBeNull();

    await act(async () => {
      stream.close();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
  });

  it("sends when it is pressed", async () => {
    const stream = await chatWithAFailedTurn();
    await act(async () => {
      stream.close();
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
});
