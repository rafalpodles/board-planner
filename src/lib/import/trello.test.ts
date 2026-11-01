import { describe, it, expect } from "vitest";
import fixture from "./__fixtures__/trello-board.json";
import { parseBundle, type ImportTask } from "./bundle";
import { csvToBundle, guessTargets, knownSource } from "./csv";
import { IMPORT_NOTE_MAX_LENGTH } from "./limits";
import { isTrelloExport, trelloToTable } from "./trello";

const LABELS = { name: "Labels", fieldType: "multiselect" };

const copy = () => JSON.parse(JSON.stringify(fixture)) as typeof fixture & Record<string, unknown>;

function bundleOf(board: Record<string, unknown>) {
  const table = trelloToTable(board);
  return { table, bundle: csvToBundle(table, guessTargets(table.headers, [LABELS]), "Trello", [LABELS], "u1") };
}

const named = (tasks: ImportTask[], title: string) => tasks.find((t) => t.title === title)!;

describe("isTrelloExport", () => {
  it("knows a board export from a bundle and from anything else", () => {
    expect(isTrelloExport(fixture)).toBe(true);
    expect(isTrelloExport({ source: "x", tasks: [], cards: [], lists: [] })).toBe(false);
    expect(isTrelloExport({ bundle: {}, cards: [], lists: [] })).toBe(false);
    expect(isTrelloExport({ title: "Another kanban tool", cards: [], lists: [] })).toBe(false);
    expect(isTrelloExport({ cards: [], shortLink: "aBcD1234" })).toBe(false);
    expect(isTrelloExport({ lists: [], shortLink: "aBcD1234" })).toBe(false);
    expect(isTrelloExport([])).toBe(false);
    expect(isTrelloExport(null)).toBe(false);
  });
});

describe("trelloToTable", () => {
  it("is recognised, and its columns need no mapping by hand", () => {
    const table = trelloToTable(fixture);
    expect(knownSource(table.headers)?.name).toBe("Trello");
    expect(knownSource(["Task", "Trello card", "ID"])).toBeNull();
    expect(guessTargets(table.headers, [LABELS])).toEqual(["id", "title", "status", "assignee", "dueDate", "createdAt", "completedAt", "description", "field:Labels"]);
  });

  it("makes a bundle the server takes, of the open cards in the board's own order", () => {
    const { bundle } = bundleOf(fixture);
    expect(parseBundle(JSON.parse(JSON.stringify(bundle))).ok).toBe(true);
    expect(bundle.tasks.map((t) => t.status)).toEqual(["Backlog", "Backlog", "Doing", "Done", "Ideas", "Ideas", "Later", "Later", "Parked"]);
    expect(bundle.tasks.map((t) => t.title)).not.toContain("Mobile menu");
    expect(bundle.tasks.every((t) => /^[A-Za-z0-9]{8}$/.test(t.id))).toBe(true);
    expect(bundle.tasks.map((t) => t.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("goes by each thing's position, not by where the file happens to write it", () => {
    const ordered = bundleOf(fixture).bundle.tasks;
    const board = copy();
    board.lists.reverse();
    board.cards.reverse();
    board.checklists.reverse();
    for (const checklist of board.checklists) checklist.checkItems.reverse();
    expect(bundleOf(board).bundle.tasks.map((t) => [t.title, t.checklist])).toEqual(ordered.map((t) => [t.title, t.checklist]));
  });

  it("reports archived cards and lists instead of importing them", () => {
    const { bundle } = bundleOf(fixture);
    expect(bundle.notes).toContainEqual({ id: "Old ideas", what: "an archived list, with its 1 card" });
    expect(bundle.notes).toContainEqual({ id: "https://example.com/link-8", what: "an archived card" });
    expect(bundle.tasks).toHaveLength(9);
  });

  it("does not list an archived list with nothing in it, which leaves nothing behind", () => {
    const board = copy();
    board.lists.push({ ...board.lists[0], id: "empty-list", name: "Old sprint", closed: true });
    expect(bundleOf(board).bundle.notes?.some((n) => n.id === "Old sprint")).toBe(false);
  });

  it("carries checklists as criteria in order, each with its checklist's name once there are two", () => {
    const { bundle } = bundleOf(fixture);
    const task = named(bundle.tasks, "Invoice export");
    expect(task.checklist).toEqual([
      { text: "Definition of done: Step 1", done: true },
      { text: "Definition of done: Step 2", done: false },
      { text: "Definition of done: Step 3", done: false },
      { text: "Rollout: Tell people 1", done: false },
      { text: "Rollout: Tell people 2", done: false },
      { text: "Rollout: Tell people 3", done: false },
    ]);
    expect(bundle.notes).toContainEqual({ id: "Invoice export", what: "the split into 2 checklists: each criterion starts with its checklist's name" });
  });

  it("names no checklist when a card has only one", () => {
    const board = copy();
    board.checklists = board.checklists.slice(0, 1);
    const { bundle } = bundleOf(board);
    expect(named(bundle.tasks, "Invoice export").checklist?.[0]).toEqual({ text: "Step 1", done: true });
    expect(bundle.notes?.some((n) => n.what.startsWith("the split"))).toBe(false);
  });

  it("skips a blank item and an empty checklist, which would otherwise read as a criterion and a second checklist", () => {
    const board = copy();
    board.checklists[0].checkItems[0].name = "  ";
    board.checklists[1].checkItems = [];
    const { bundle } = bundleOf(board);
    expect(named(bundle.tasks, "Invoice export").checklist?.map((c) => c.text)).toEqual(["Step 2", "Step 3"]);
    expect(bundle.notes?.some((n) => n.what.startsWith("the split"))).toBe(false);
  });

  it("carries comments oldest first, by their author's username, and known by Trello's own id", () => {
    const { bundle } = bundleOf(fixture);
    const { comments } = named(bundle.tasks, "Single sign-on");
    expect(comments?.map((c) => [c.author, c.body])).toEqual([
      ["member2", "Comment 10 on this card."],
      ["member1", "Comment 3 on this card."],
    ]);
    expect(comments?.map((c) => c.createdAt)).toEqual(["2018-03-26T20:27:09.771Z", "2023-11-07T04:45:37.449Z"]);
    expect(comments?.every((c) => /^[0-9a-f]{24}$/.test(c.id))).toBe(true);
  });

  it("says how many comments the export's limit of 1,000 actions left out", () => {
    const { bundle } = bundleOf(fixture);
    expect(bundle.notes).toContainEqual({ id: "Audit log filter", what: "2,294 of its 2,294 comments: the export holds only the board's newest 1,000 actions" });
    expect(bundle.notes?.some((n) => n.id === "Single sign-on" && n.what.includes("comment"))).toBe(false);
  });

  it("counts only the comments that are missing when the file holds some of them", () => {
    const board = copy();
    board.cards.find((c) => c.name === "Single sign-on")!.badges.comments = 5;
    expect(bundleOf(board).bundle.notes).toContainEqual({ id: "Single sign-on", what: "3 of its 5 comments: the export holds only the board's newest 1,000 actions" });
  });

  it("gives a task the first member and names the others, matched by username", () => {
    const { table, bundle } = bundleOf(fixture);
    expect(named(bundle.tasks, "Single sign-on").assignee).toBe("member1");
    expect(table.rows.map((r) => r[3])).toContain("member1, member2");
    expect(bundle.notes).toContainEqual({ id: "Single sign-on", what: "its other members, as a task has one assignee: member2" });
  });

  it("says when a card names a member the export does not", () => {
    const board = copy();
    (board.cards.find((c) => c.name === "Single sign-on")!.idMembers as string[]).push("gone-from-the-board");
    expect(bundleOf(board).bundle.notes).toContainEqual({ id: "Single sign-on", what: "1 member the export does not name" });
  });

  it("takes the creation time from the card's id and the due date as a day", () => {
    const { bundle } = bundleOf(fixture);
    const task = named(bundle.tasks, "Audit log filter");
    const card = fixture.cards.find((c) => c.name === "Audit log filter")!;
    expect(task.createdAt).toBe(new Date(parseInt(card.id.slice(0, 8), 16) * 1000).toISOString());
    expect(task.dueDate).toBe("2017-04-12");
  });

  it("keeps the time a card was marked complete", () => {
    const board = copy();
    (board.cards.find((c) => c.name === "Backup restore") as Record<string, unknown>).dateCompleted = "2026-03-01T10:00:00.000Z";
    expect(named(bundleOf(board).bundle.tasks, "Backup restore").completedAt).toBe("2026-03-01T10:00:00.000Z");
  });

  it("leaves a task with no creation time when the id is not Trello's", () => {
    const board = copy();
    board.cards[0].id = "not-a-trello-id";
    expect(bundleOf(board).bundle.tasks.every((t) => t.title !== board.cards[0].name || t.createdAt === undefined)).toBe(true);
  });

  it("keeps a link in the description and names each uploaded file per card", () => {
    const { bundle } = bundleOf(fixture);
    expect(named(bundle.tasks, "Rate limit banner").description).toBe("Links from Trello:\n- [Design note 5](https://example.com/notes/5)");
    expect(named(bundle.tasks, "Search by label").description).toBe("Notes for **Search by label**.\n\nA second paragraph.\n\nLinks from Trello:\n- [Design note 6](https://example.com/notes/6)");
    expect(bundle.notes).toContainEqual({ id: "Audit log filter", what: "2 uploaded files: screenshot-3-0.png, screenshot-3-1.png" });
    expect(bundle.notes).toContainEqual({ id: "Rate limit banner", what: "1 uploaded file: screenshot-5-1.png" });
    expect(bundle.notes?.filter((n) => n.what.includes("uploaded file")).map((n) => n.id).sort()).toEqual(["Audit log filter", "Backup restore", "Rate limit banner", "Search by label"]);
  });

  it("writes a link named after its own address as the address alone", () => {
    const board = copy();
    const card = board.cards.find((c) => c.name === "Rate limit banner")!;
    card.attachments = [{ isUpload: false, name: "https://example.com/a", url: "https://example.com/a" }, { isUpload: false, name: "", url: "https://example.com/b" }] as never;
    expect(named(bundleOf(board).bundle.tasks, "Rate limit banner").description).toBe("Links from Trello:\n- https://example.com/a\n- https://example.com/b");
  });

  it("writes no link that is not a web address, and says what it left out", () => {
    const board = copy();
    const card = board.cards.find((c) => c.name === "Rate limit banner")!;
    card.attachments = [{ isUpload: false, name: "Run me", url: "javascript:alert(1)" }] as never;
    const { bundle } = bundleOf(board);
    expect(named(bundle.tasks, "Rate limit banner").description).toBeUndefined();
    expect(bundle.notes).toContainEqual({ id: "Rate limit banner", what: "1 attachment with no web address: Run me" });
  });

  it("names five uploads on a card and counts the rest", () => {
    const board = copy();
    const card = board.cards.find((c) => c.name === "Rate limit banner")!;
    card.attachments = Array.from({ length: 7 }, (_, i) => ({ isUpload: true, name: `f${i}.png` })) as never;
    expect(bundleOf(board).bundle.notes).toContainEqual({ id: "Rate limit banner", what: "7 uploaded files: f0.png, f1.png, f2.png, f3.png, f4.png and 2 more" });
  });

  it("writes a link so that its name and address cannot break out of the Markdown", () => {
    const board = copy();
    const card = board.cards.find((c) => c.name === "Rate limit banner")!;
    card.attachments = [{ isUpload: false, name: "a [b]\nc", url: "https://example.com/x (1)" }] as never;
    expect(named(bundleOf(board).bundle.tasks, "Rate limit banner").description).toContain("- [a  b  c](https://example.com/x%20%281%29)");
  });

  it("puts a card's labels in the board's labels field, a label with no name by its colour", () => {
    const board = copy();
    const card = board.cards.find((c) => c.name === "Webhook retries")!;
    expect(named(bundleOf(board).bundle.tasks, "Webhook retries").fields).toEqual({ Labels: ["design"] });
    card.labels = [{ name: "", color: "green" }, { name: "ops", color: "red" }] as never;
    const { table, bundle } = bundleOf(board);
    expect(table.headers.filter((h) => h === "Labels")).toHaveLength(2);
    expect(named(bundle.tasks, "Webhook retries").fields).toEqual({ Labels: ["green", "ops"] });
  });

  it("reports custom fields, Power-Ups and start dates as not carried", () => {
    const board = copy();
    board.customFields = [{ id: "cf1", name: "Effort" }] as never;
    board.cards[3].pluginData = [{ id: "p1" }] as never;
    (board.cards[3] as Record<string, unknown>).start = "2026-01-01T00:00:00.000Z";
    const { notes } = bundleOf(board).bundle;
    expect(notes).toContainEqual({ id: "Effort", what: "a Trello custom field: its values are not carried" });
    expect(notes).toContainEqual({ id: "Power-Ups", what: "what they keep on 1 card is not carried" });
    expect(notes).toContainEqual({ id: "Start dates", what: "on 1 card: a task has none" });
  });

  it("reports Power-Ups kept on the board alone", () => {
    for (const on of [{ powerUps: ["cardAging"] }, { pluginData: [{ id: "p1" }] }]) {
      expect(bundleOf({ ...copy(), ...on }).bundle.notes).toContainEqual({ id: "Power-Ups", what: "what they keep is not carried" });
    }
    expect(bundleOf(copy()).bundle.notes?.some((n) => n.id === "Power-Ups")).toBe(false);
  });

  it("clips what it notes, so one long name cannot refuse the whole import", () => {
    const board = copy();
    board.cards.find((c) => c.name === "Audit log filter")!.name = "x".repeat(5_000);
    board.lists.find((l) => l.name === "Old ideas")!.name = "y".repeat(5_000);
    expect(parseBundle(JSON.parse(JSON.stringify(bundleOf(board).bundle))).ok).toBe(true);
  });

  it("clips the whole note, however many long names it holds", () => {
    const board = copy();
    const card = board.cards.find((c) => c.name === "Rate limit banner")!;
    card.attachments = Array.from({ length: 5 }, (_, i) => ({ isUpload: true, name: `${i}${"z".repeat(200)}` })) as never;
    card.name = "Long".repeat(200);
    const { bundle } = bundleOf(board);
    expect(Math.max(...(bundle.notes ?? []).map((n) => n.what.length))).toBeLessThanOrEqual(IMPORT_NOTE_MAX_LENGTH);
    expect(parseBundle(JSON.parse(JSON.stringify(bundle))).ok).toBe(true);
  });

  it("clips a note whose names are not cut to a length of their own", () => {
    const board = copy();
    board.customFields = [{ id: "cf1", name: "Effort" }] as never;
    const { notes } = bundleOf({ ...board, powerUps: ["cardAging"] }).bundle;
    expect(notes?.every((n) => n.what.length <= IMPORT_NOTE_MAX_LENGTH)).toBe(true);
    const many = copy();
    const card = many.cards.find((c) => c.name === "Rate limit banner")!;
    card.attachments = Array.from({ length: 5 }, () => ({ isUpload: true, name: "y".repeat(120) })) as never;
    expect(bundleOf(many).bundle.notes?.find((n) => n.what.includes("uploaded"))?.what.length).toBeLessThanOrEqual(IMPORT_NOTE_MAX_LENGTH);
  });

  it("names something with no name after Trello, so that a blank cannot refuse the import", () => {
    const board = copy();
    board.lists.find((l) => l.name === "Old ideas")!.name = "   ";
    board.customFields = [{ id: "cf1", name: "" }] as never;
    const { bundle } = bundleOf(board);
    expect(bundle.notes).toContainEqual({ id: "Trello", what: "an archived list, with its 1 card" });
    expect(bundle.notes).toContainEqual({ id: "Trello", what: "a Trello custom field: its values are not carried" });
    expect(parseBundle(JSON.parse(JSON.stringify(bundle))).ok).toBe(true);
  });

  it("survives a file missing what it usually holds", () => {
    expect(trelloToTable({ cards: [{ id: "a", name: "Only a name" }], lists: [] }).rows).toHaveLength(1);
    expect(trelloToTable({ cards: [null, 1], lists: [{}], actions: [{}], checklists: "x" }).rows).toHaveLength(0);
  });
});
