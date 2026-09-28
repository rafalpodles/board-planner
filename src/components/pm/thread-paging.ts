import type { ApiPmMessage } from "@/types";

export interface ThreadPage {
  messages: ApiPmMessage[];
  nextCursor: string | null;
}

export const EMPTY_THREAD: ThreadPage = { messages: [], nextCursor: null };

const isLocal = (message: ApiPmMessage) => message._id.startsWith("local-");

// ObjectIds are fixed-length lowercase hex, so string order is the route's `_id` order
export function withNewestPage(current: ThreadPage, newest: ThreadPage): ThreadPage {
  if (!newest.nextCursor || newest.messages.length === 0) return newest;
  const oldestFresh = newest.messages[0]._id;
  const loaded = current.messages.filter((message) => !isLocal(message));
  // A gap between what was loaded and the fresh page would hide the messages in it
  if (!loaded.some((message) => message._id >= oldestFresh)) return newest;
  const older = loaded.filter((message) => message._id < oldestFresh);
  if (older.length === 0) return newest;
  return { messages: [...older, ...newest.messages], nextCursor: current.nextCursor };
}

export function withOlderPage(current: ThreadPage, requestedBefore: string, older: ThreadPage): ThreadPage {
  if (current.nextCursor !== requestedBefore) return current;
  return { messages: [...older.messages, ...current.messages], nextCursor: older.nextCursor };
}
