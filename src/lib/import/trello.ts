import type { ImportChecklistItem, ImportComment, ImportNote } from "./bundle";
import type { CsvTable } from "./csv";
import { EXTERNAL_ID_MAX_LENGTH, IMPORT_NOTE_MAX_LENGTH } from "./limits";

type Json = Record<string, unknown>;

const NAMES_LISTED = 5;

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const records = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const text = (v: unknown) => (typeof v === "string" ? v : "");
const inPlace = (rows: Json[]) => [...rows].sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0));

export function isTrelloExport(value: unknown): value is Json {
  return isRecord(value) && Array.isArray(value.cards) && Array.isArray(value.lists) && !("tasks" in value);
}

// A card has no date of its own: its id starts with the Unix time it was made at
function madeAt(id: string): string {
  return /^[0-9a-f]{24}$/i.test(id) ? new Date(parseInt(id.slice(0, 8), 16) * 1000).toISOString() : "";
}

const plural = (n: number, noun: string) => `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;

const note = (id: string, what: string): ImportNote => ({
  id: id.trim().slice(0, EXTERNAL_ID_MAX_LENGTH) || "Trello",
  what: what.slice(0, IMPORT_NOTE_MAX_LENGTH),
});

function namedUpTo(names: string[]): string {
  const shown = names.slice(0, NAMES_LISTED).map((n) => n.slice(0, 60)).join(", ");
  return names.length > NAMES_LISTED ? `${shown} and ${names.length - NAMES_LISTED} more` : shown;
}

function linkLine(attachment: Json): string {
  const url = text(attachment.url).replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
  const name = text(attachment.name).replace(/[[\]\r\n]/g, " ").trim();
  return name && name !== text(attachment.url) ? `- [${name}](${url})` : `- ${url}`;
}

function descriptionOf(card: Json, links: Json[]): string {
  const desc = text(card.desc).trim();
  return [desc, links.length ? ["Links from Trello:", ...links.map(linkLine)].join("\n") : ""].filter(Boolean).join("\n\n");
}

function commentsByCard(board: Json): Map<string, ImportComment[]> {
  const byCard = new Map<string, ImportComment[]>();
  // The export writes its actions newest first
  for (const action of records(board.actions).reverse()) {
    const data = isRecord(action.data) ? action.data : {};
    const card = isRecord(data.card) ? text(data.card.id) : "";
    const id = text(action.id);
    if (action.type !== "commentCard" || !card || !id) continue;
    const author = isRecord(action.memberCreator) ? text(action.memberCreator.username) : "";
    const comment: ImportComment = { id, body: text(data.text), ...(author && { author }), ...(text(action.date) && { createdAt: text(action.date) }) };
    byCard.set(card, [...(byCard.get(card) ?? []), comment]);
  }
  return byCard;
}

function checklistsByCard(board: Json): Map<string, Json[]> {
  const byCard = new Map<string, Json[]>();
  for (const checklist of inPlace(records(board.checklists))) {
    const card = text(checklist.idCard);
    byCard.set(card, [...(byCard.get(card) ?? []), checklist]);
  }
  return byCard;
}

function criteriaOf(checklists: Json[]): ImportChecklistItem[] {
  return checklists.flatMap((checklist) =>
    inPlace(records(checklist.checkItems)).map((item) => ({
      text: checklists.length > 1 ? `${text(checklist.name)}: ${text(item.name)}` : text(item.name),
      done: item.state === "complete",
    }))
  );
}

function missedComments(card: Json, carried: number): string | null {
  const counted = isRecord(card.badges) ? Number(card.badges.comments) || 0 : 0;
  if (counted <= carried) return null;
  return `${counted - carried} of its ${plural(counted, "comment")}: the export holds only the board's newest 1,000 actions`;
}

function boardNotes(board: Json, open: Json[]): ImportNote[] {
  const notes: ImportNote[] = [];
  const closedLists = records(board.lists).filter((l) => l.closed === true);
  const cards = records(board.cards);
  for (const list of closedLists) {
    const inIt = cards.filter((c) => c.idList === list.id).length;
    if (inIt) notes.push(note(text(list.name), `an archived list, with its ${plural(inIt, "card")}`));
  }
  for (const field of records(board.customFields)) notes.push(note(text(field.name), "a Trello custom field: its values are not carried"));
  const powered = open.filter((c) => records(c.pluginData).length > 0).length;
  if (powered > 0 || (Array.isArray(board.powerUps) && board.powerUps.length > 0)) {
    notes.push(note("Power-Ups", powered ? `what they keep on ${plural(powered, "card")} is not carried` : "what they keep is not carried"));
  }
  const started = open.filter((c) => text(c.start)).length;
  if (started) notes.push(note("Start dates", `on ${plural(started, "card")}: a task has none`));
  return notes;
}

/**
 * Trello's board export is laid out as a sheet would be, so a list is matched to a column and a
 * member to an account in the mapping step every other import goes through. Everything the file
 * holds that a task cannot is written into `notes` for the report.
 */
export function trelloToTable(board: Json): CsvTable {
  const lists = new Map(records(board.lists).map((l) => [text(l.id), l]));
  const members = new Map(records(board.members).map((m) => [text(m.id), text(m.username) || text(m.fullName)]));
  const comments = commentsByCard(board);
  const checklists = checklistsByCard(board);
  const listRank = new Map(inPlace([...lists.values()]).map((l, i) => [text(l.id), i]));
  const rank = (card: Json) => listRank.get(text(card.idList)) ?? listRank.size;
  const cards = inPlace(records(board.cards)).sort((a, b) => rank(a) - rank(b));
  const inOpenLists = cards.filter((c) => lists.get(text(c.idList))?.closed !== true);
  const open = inOpenLists.filter((c) => c.closed !== true);

  const notes = boardNotes(board, open);
  const noteOn = (card: Json, what: string | null) => {
    if (what) notes.push(note(text(card.name) || text(card.id), what));
  };
  for (const card of inOpenLists) if (card.closed === true) noteOn(card, "an archived card");

  const rows = open.map((card) => {
    const id = text(card.id);
    const attachments = records(card.attachments);
    const uploads = attachments.filter((a) => a.isUpload === true);
    const links = attachments.filter((a) => a.isUpload !== true && /^https?:\/\//i.test(text(a.url)));
    const people = (Array.isArray(card.idMembers) ? card.idMembers : []).flatMap((m) => members.get(text(m)) || []);
    const itsChecklists = checklists.get(id) ?? [];
    const said = comments.get(id) ?? [];

    if (uploads.length) noteOn(card, `${plural(uploads.length, "uploaded file")}: ${namedUpTo(uploads.map((u) => text(u.name)))}`);
    if (people.length > 1) noteOn(card, `its other members, as a task has one assignee: ${namedUpTo(people.slice(1))}`);
    if (itsChecklists.length > 1) noteOn(card, `the split into ${itsChecklists.length} checklists: each criterion starts with its checklist's name`);
    noteOn(card, missedComments(card, said.length));

    return {
      cells: [
        text(card.shortLink) || id,
        text(card.name),
        text(lists.get(text(card.idList))?.name),
        people.join(", "),
        text(card.due).slice(0, 10),
        madeAt(id),
        text(card.dateCompleted),
        descriptionOf(card, links),
      ],
      labels: records(card.labels).flatMap((l) => text(l.name) || text(l.color) || []),
      said,
      criteria: criteriaOf(itsChecklists),
    };
  });

  const labelColumns = Math.max(0, ...rows.map((r) => r.labels.length));
  return {
    headers: ["Trello card", "Name", "List", "Members", "Due", "Created", "Completed", "Description", ...Array(labelColumns).fill("Labels")],
    rows: rows.map((r) => [...r.cells, ...r.labels, ...Array(labelColumns - r.labels.length).fill("")]),
    comments: rows.map((r) => r.said),
    checklists: rows.map((r) => r.criteria),
    notes,
  };
}
