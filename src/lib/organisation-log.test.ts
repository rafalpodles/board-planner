import { describe, it, expect, vi } from "vitest";
import { Types } from "mongoose";
import { inOrganisation, loggingOrganisation, tagConsoleWithOrganisation } from "./organisation-log";

const ACME = new Types.ObjectId("0000000000000000000000a1");
const GLOBEX = new Types.ObjectId("0000000000000000000000b2");

function fakeConsole() {
  const calls: unknown[][] = [];
  const record = (...args: unknown[]) => void calls.push(args);
  const target = { log: record, info: record, warn: record, error: record, debug: record };
  tagConsoleWithOrganisation(target as unknown as Console);
  return { target, calls };
}

describe("organisation in every log line (BP-894)", () => {
  it("names the organisation a line was written for, through awaits", async () => {
    const { target, calls } = fakeConsole();

    await inOrganisation(ACME, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      target.error("sync failed", 42);
    });

    expect(calls).toEqual([[`[organisation ${ACME.toHexString()}]`, "sync failed", 42]]);
  });

  it("keeps two organisations' concurrent work apart", async () => {
    const { target, calls } = fakeConsole();

    await Promise.all([
      inOrganisation(ACME, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        target.warn("acme");
      }),
      inOrganisation(GLOBEX, async () => {
        target.warn("globex");
      }),
    ]);

    expect(calls).toContainEqual([`[organisation ${GLOBEX.toHexString()}]`, "globex"]);
    expect(calls).toContainEqual([`[organisation ${ACME.toHexString()}]`, "acme"]);
  });

  it("writes a line outside any organisation as it was", () => {
    const { target, calls } = fakeConsole();

    target.log("boot");

    expect(loggingOrganisation()).toBeUndefined();
    expect(calls).toEqual([["boot"]]);
  });
});

describe("the middleware and the jobs run inside their organisation", () => {
  it("forEachServedOrganisation runs each organisation's work, and logs its failure, inside it", async () => {
    vi.resetModules();
    vi.doMock("./db", () => ({ connectDB: vi.fn() }));
    vi.doMock("@/models/organisation", () => ({
      Organisation: { find: () => ({ select: () => ({ lean: () => Promise.resolve([{ _id: ACME }, { _id: GLOBEX }]) }) }) },
    }));
    const { forEachServedOrganisation } = await import("./organisation-jobs");
    const seen: (string | undefined)[] = [];

    await forEachServedOrganisation("test job", async () => {
      seen.push(loggingOrganisation());
    });

    expect(seen).toEqual([ACME.toHexString(), GLOBEX.toHexString()]);
    vi.doUnmock("./db");
    vi.doUnmock("@/models/organisation");
  });
});
