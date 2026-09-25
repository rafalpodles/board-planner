import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();
vi.mock("@/models/projectAuditLog", () => ({ ProjectAuditLog: { create } }));

const { logProjectAudit } = await import("./projectAudit");

const written = () => create.mock.calls[0][0].detail as string;

beforeEach(() => create.mockReset());

// The view renders a detail's line breaks, so a name typed with one in it must not become a line
// of its own that reads like a settings change
describe("logProjectAudit", () => {
  it("keeps a detail passed as one string on one line", async () => {
    await logProjectAudit("p1", "u1", "template_added", "Bug\nRepository: a → b\u0000\t x");

    expect(written()).toBe("Bug Repository: a → b x");
  });

  it("writes lines passed as lines one to a line, each flattened", async () => {
    await logProjectAudit("p1", "u1", "settings_updated", ["Name: A → B", "Coda doc:\n none → d1", "  "]);

    expect(written()).toBe("Name: A → B\nCoda doc: none → d1");
  });
});
