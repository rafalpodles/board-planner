import { describe, expect, it, vi } from "vitest";

const modelKeyAvailability = vi.hoisted(() => vi.fn());
vi.mock("@/lib/model-keys", () => ({ modelKeyAvailability }));

const { pmAvailability } = await import("./config");

// BP-652. Asked on every board poll, so a failed read must not read as "no key"
describe("pmAvailability", () => {
  it("renames what the key lookup says for the PM screens", async () => {
    modelKeyAvailability.mockResolvedValue({ available: false, needsPlan: true, unreadable: false });

    expect(await pmAvailability({} as never)).toEqual({ available: false, needsPlan: true, keyUnreadable: false });
    expect(modelKeyAvailability).toHaveBeenCalledWith({});
  });

  it("answers null, not a verdict, when the lookup fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    modelKeyAvailability.mockRejectedValue(new Error("database blip"));

    expect(await pmAvailability({} as never)).toBeNull();
  });
});
