import { describe, expect, it } from "vitest";
import type { ApiPmMessage } from "@/types";
import { withNewestPage, withOlderPage, type ThreadPage } from "./thread-paging";

const id = (n: number) => n.toString(16).padStart(24, "0");
const message = (_id: string) => ({ _id, role: "user", content: _id }) as ApiPmMessage;
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => message(id(from + i)));
const ids = (page: ThreadPage) => page.messages.map((m) => m._id);

// BP-787
describe("withNewestPage", () => {
  it("keeps the older pages a reader already loaded when the fresh page overlaps them", () => {
    const loaded: ThreadPage = { messages: range(1, 100), nextCursor: null };
    const fresh: ThreadPage = { messages: range(52, 101), nextCursor: id(52) };

    const merged = withNewestPage(loaded, fresh);

    expect(ids(merged)).toEqual(range(1, 101).map((m) => m._id));
    expect(merged.nextCursor, "the cursor still points below the oldest loaded page").toBeNull();
  });

  it("keeps the cursor of the oldest loaded page, not the fresh page's", () => {
    const loaded: ThreadPage = { messages: range(11, 100), nextCursor: id(11) };
    const fresh: ThreadPage = { messages: range(52, 101), nextCursor: id(52) };

    expect(withNewestPage(loaded, fresh).nextCursor).toBe(id(11));
  });

  it("replaces an optimistic message with the stored one", () => {
    const loaded: ThreadPage = {
      messages: [...range(1, 60), message("local-0")],
      nextCursor: null,
    };
    const fresh: ThreadPage = { messages: range(12, 61), nextCursor: id(12) };

    const merged = withNewestPage(loaded, fresh);

    expect(ids(merged)).toEqual(range(1, 61).map((m) => m._id));
  });

  it("starts again from the fresh page when a gap would hide the messages in between", () => {
    const loaded: ThreadPage = { messages: range(1, 100), nextCursor: null };
    const fresh: ThreadPage = { messages: range(151, 200), nextCursor: id(151) };

    expect(withNewestPage(loaded, fresh)).toEqual(fresh);
  });

  it("does not let an optimistic message bridge a gap", () => {
    const loaded: ThreadPage = { messages: [...range(1, 100), message("local-0")], nextCursor: null };
    const fresh: ThreadPage = { messages: range(151, 200), nextCursor: id(151) };

    expect(withNewestPage(loaded, fresh)).toEqual(fresh);
  });

  it("takes the fresh page whole when it is the whole thread", () => {
    const loaded: ThreadPage = { messages: [...range(1, 10), message("local-0")], nextCursor: null };
    const fresh: ThreadPage = { messages: range(1, 11), nextCursor: null };

    expect(withNewestPage(loaded, fresh)).toEqual(fresh);
  });
});

describe("withOlderPage", () => {
  it("puts the older page in front and moves the cursor", () => {
    const loaded: ThreadPage = { messages: range(51, 100), nextCursor: id(51) };
    const older: ThreadPage = { messages: range(1, 50), nextCursor: null };

    const merged = withOlderPage(loaded, id(51), older);

    expect(ids(merged)).toEqual(range(1, 100).map((m) => m._id));
    expect(merged.nextCursor).toBeNull();
  });

  it("drops a page asked for with a cursor the thread has moved past", () => {
    const loaded: ThreadPage = { messages: range(1, 100), nextCursor: null };
    const late: ThreadPage = { messages: range(1, 50), nextCursor: null };

    expect(withOlderPage(loaded, id(51), late), "a second click's answer").toBe(loaded);
  });
});
