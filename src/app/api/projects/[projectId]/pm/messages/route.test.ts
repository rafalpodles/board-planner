import { describe, it, expect, vi, beforeEach } from "vitest";
import { scopedToDefaultOrganisation } from "@/lib/db-scope";

let thread: { _id: string }[] = [];

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (...a: unknown[]) => unknown) =>
    (request: Request, ctx: { params: Promise<{ projectId: string }> }) =>
      handler(request, { ...ctx, user: { _id: "u1", role: "member" }, db: scopedToDefaultOrganisation() }),
}));
vi.mock("@/lib/pm/thread", () => ({ pmThreadFilter: () => ({}) }));
vi.mock("@/lib/pm/abandoned", () => ({ finalizeAbandonedTurns: vi.fn() }));
vi.mock("@/models/pmMessage", () => ({
  PmMessage: {
    find: () => ({
      sort: () => ({
        limit: (n: number) => ({ populate: async () => thread.slice(0, n) }),
      }),
    }),
  },
}));

const { GET } = await import("./route");

const params = Promise.resolve({ projectId: "69a52e3b399b27d3cbb2c5a5" });

function threadOf(length: number) {
  return Array.from({ length }, (_, i) => ({ _id: String(length - i).padStart(24, "0") }));
}

async function firstPage() {
  const response = await GET(new Request("http://x/api/projects/p/pm/messages?limit=50"), { params });
  return (await response!.json()) as { messages: { _id: string }[]; nextCursor: string | null };
}

beforeEach(() => {
  thread = [];
});

// BP-752. A thread of exactly one page used to offer "Load older messages", which loaded nothing
describe("GET pm/messages paging", () => {
  it("offers no older page when the thread is exactly one page long", async () => {
    thread = threadOf(50);

    const page = await firstPage();

    expect(page.messages).toHaveLength(50);
    expect(page.nextCursor).toBeNull();
  });

  it("offers an older page when one message is left over, and does not return it yet", async () => {
    thread = threadOf(51);

    const page = await firstPage();

    expect(page.messages).toHaveLength(50);
    expect(page.messages[0]._id).toBe(String(2).padStart(24, "0"));
    expect(page.messages.at(-1)!._id).toBe(String(51).padStart(24, "0"));
    expect(page.nextCursor).toBe(String(2).padStart(24, "0"));
  });
});
