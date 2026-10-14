import { describe, it, expect, vi } from "vitest";
import { Types } from "mongoose";
import {
  AUDIT_EXPORT_PAGE,
  auditExportStream,
  auditFilter,
  auditPages,
  csvCell,
  csvLine,
  parseAuditParams,
  type AuditPage,
} from "./audit-query";

const ACTIONS = ["settings_updated", "member_added"] as const;
const parse = (query: string) => parseAuditParams(new URLSearchParams(query), ACTIONS, 100);

describe("parseAuditParams", () => {
  it("reads a bare day as the whole of that day", () => {
    const parsed = parse("from=2026-10-01&to=2026-10-14");
    expect(parsed).toMatchObject({
      ok: true,
      value: { from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-10-15T00:00:00.000Z"), limit: 100 },
    });
  });

  it.each([
    ["from=yesterday", "from must be a date"],
    ["from=2026-10-14&to=2026-10-01", "from must be before to"],
    ["action=drop_database", "Unknown action"],
    ["before=../etc", "before must be an entry id"],
    ["limit=0", "limit must be a whole number from 1 to 500"],
    ["limit=501", "limit must be a whole number from 1 to 500"],
    [`actor=${"a".repeat(101)}`, "actor is too long"],
  ])("refuses %s", (query, error) => {
    expect(parse(query)).toEqual({ ok: false, error });
  });

  it("takes an action it knows, an actor and a cursor", () => {
    const id = new Types.ObjectId().toString();
    expect(parse(`action=member_added&actor=%20rafal%20&before=${id}&limit=5`)).toEqual({
      ok: true,
      value: { action: "member_added", actor: "rafal", before: id, limit: 5 },
    });
  });
});

describe("auditFilter", () => {
  const account = new Types.ObjectId();
  const db = (found: unknown) =>
    ({ User: { findOne: () => ({ select: () => ({ lean: () => Promise.resolve(found) }) }) } }) as never;

  it("is the base alone when nothing narrows it", async () => {
    expect(await auditFilter(db(null), "project", { project: "p1" }, { limit: 10 })).toEqual({ project: "p1" });
  });

  it("narrows by date, action and the actor's account", async () => {
    const from = new Date("2026-10-01");
    expect(
      await auditFilter(db({ _id: account }), "project", { project: "p1" }, { limit: 10, from, action: "member_added", actor: "rafal" })
    ).toEqual({ $and: [{ project: "p1" }, { createdAt: { $gte: from } }, { action: "member_added" }, { user: account }] });
  });

  // A deleted account's rows are still found by the name they were written under
  it("matches the instance log's recorded name as well as the account", async () => {
    expect(await auditFilter(db(null), "instance", {}, { limit: 10, actor: "gone" })).toEqual({
      $and: [{}, { $or: [{ actorUsername: "gone" }] }],
    });
  });

  it("names nobody on a project when the actor has no account", async () => {
    expect(await auditFilter(db(null), "project", { project: "p1" }, { limit: 10, actor: "nobody" })).toBeNull();
  });
});

describe("auditPages", () => {
  function model(rows: unknown[], cursor: unknown = null) {
    const find = vi.fn(() => chain);
    const chain = {
      sort: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      populate: vi.fn(() => chain),
      lean: vi.fn(() => Promise.resolve(rows)),
    };
    const findOne = vi.fn(() => ({ select: () => ({ lean: () => Promise.resolve(cursor) }) }));
    return { find, findOne, chain };
  }

  it("asks for one row more than a page, so it knows whether another follows", async () => {
    const ids = [1, 2, 3].map(() => new Types.ObjectId());
    const m = model(ids.map((_id) => ({ _id })));
    const page = (await auditPages(m as never, { project: "p1" })(undefined, 2)) as AuditPage<{ _id: Types.ObjectId }>;

    expect(m.chain.limit).toHaveBeenCalledWith(3);
    expect(m.chain.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(page.rows).toHaveLength(2);
    expect(page.next).toBe(String(ids[1]));
  });

  it("continues strictly after the cursor's own position, ties broken by id", async () => {
    const at = new Date("2026-10-10");
    const cursor = { _id: new Types.ObjectId(), createdAt: at };
    const m = model([], cursor);
    await auditPages(m as never, { project: "p1" })(String(cursor._id), 10);

    expect(m.find).toHaveBeenCalledWith({
      $and: [{ project: "p1" }, { $or: [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: cursor._id } }] }],
    });
  });

  it("says so when the cursor names no entry", async () => {
    const m = model([], null);
    expect(await auditPages(m as never, {})(String(new Types.ObjectId()), 10)).toBe("unknown-cursor");
  });

  it("reads nothing when the filter names nobody", async () => {
    const m = model([{ _id: new Types.ObjectId() }]);
    expect(await auditPages(m as never, null)(undefined, 10)).toEqual({ rows: [], next: null });
    expect(m.find).not.toHaveBeenCalled();
  });
});

describe("csvCell", () => {
  it.each([
    ["=HYPERLINK(\"http://evil\")", "\"'=HYPERLINK(\"\"http://evil\"\")\""],
    ["+1", "'+1"],
    ["-2", "'-2"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tx", "'\tx"],
    ["plain", "plain"],
    ["a,b", "\"a,b\""],
    ["two\nlines", "\"two\nlines\""],
  ])("writes %j as text", (value, cell) => {
    expect(csvCell(value)).toBe(cell);
  });

  it("ends a line with CRLF", () => {
    expect(csvLine(["a", 1])).toBe("a,1\r\n");
  });
});

describe("auditExportStream", () => {
  const SHAPE = { columns: ["n", "detail"], record: (row: { n: number }) => ({ n: row.n, detail: `=${row.n}` }) };

  function fiftyThousand() {
    const total = 50_000;
    const asked: number[] = [];
    const read = vi.fn(async (before: string | undefined, limit: number) => {
      const start = before ? Number(before) : 0;
      asked.push(limit);
      const rows = Array.from({ length: Math.min(limit, total - start) }, (_, i) => ({ n: start + i }));
      const end = start + rows.length;
      return { rows, next: end < total ? String(end) : null };
    });
    return { read, asked, total };
  }

  it("reads the log a page at a time, only as fast as it is consumed", async () => {
    const { read, asked } = fiftyThousand();
    const reader = auditExportStream(read, SHAPE, "ndjson").getReader();

    await reader.read();
    expect(read).toHaveBeenCalledTimes(1);
    await reader.read();
    expect(read).toHaveBeenCalledTimes(2);
    expect(asked.every((limit) => limit === AUDIT_EXPORT_PAGE)).toBe(true);
    await reader.cancel();
  });

  it("writes every row once, as CSV with a header and formulas defused", async () => {
    const { read, total } = fiftyThousand();
    const text = await new Response(auditExportStream(read, SHAPE, "csv")).text();
    const lines = text.split("\r\n").filter(Boolean);

    expect(lines[0]).toBe("n,detail");
    expect(lines).toHaveLength(total + 1);
    expect(lines[1]).toBe("0,'=0");
    expect(lines.at(-1)).toBe(`${total - 1},'=${total - 1}`);
    expect(read).toHaveBeenCalledTimes(total / AUDIT_EXPORT_PAGE);
  });

  it("writes one JSON object per line as NDJSON", async () => {
    const read = async () => ({ rows: [{ n: 1 }, { n: 2 }], next: null });
    const text = await new Response(auditExportStream(read, SHAPE, "ndjson")).text();
    expect(text.trim().split("\n").map((l) => JSON.parse(l))).toEqual([
      { n: 1, detail: "=1" },
      { n: 2, detail: "=2" },
    ]);
  });

  it("writes only the header for an empty log", async () => {
    const read = async () => ({ rows: [], next: null });
    expect(await new Response(auditExportStream(read, SHAPE, "csv")).text()).toBe("n,detail\r\n");
  });
});
