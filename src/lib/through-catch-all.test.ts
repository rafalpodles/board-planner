import { describe, it, expect, vi } from "vitest";
import { throughCatchAll } from "./through-catch-all";

const request = new Request("https://app.example.com/x", { method: "PATCH" });

describe("throughCatchAll", () => {
  it("hands the handler the ids under the names it was given", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const route = throughCatchAll(["projectId", "taskId", "itemId"], handler);

    const response = await route(request, { params: Promise.resolve({ ids: ["p1", "t1", "i1"] }) });

    expect(await response.text()).toBe("ok");
    const [passed, context] = handler.mock.calls[0] as unknown as [Request, { params: Promise<Record<string, string>> }];
    expect(passed).toBe(request);
    expect(await context.params).toEqual({ projectId: "p1", taskId: "t1", itemId: "i1" });
  });

  it("answers 404 and never calls the handler when there are too few or too many ids", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const route = throughCatchAll(["projectId", "taskId", "itemId"], handler);

    for (const ids of [["p1", "t1"], ["p1", "t1", "i1", "extra"], []]) {
      const response = await route(request, { params: Promise.resolve({ ids }) });
      expect(response.status, JSON.stringify(ids)).toBe(404);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
