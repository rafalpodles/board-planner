import {
  NOTIFICATION_TYPES,
  NotificationChannels,
  NotificationMatrix,
  NotificationType,
  PersonalChatKind,
} from "@/types";

/** What a user record has to carry for any of this to resolve. Deliberately narrow: the dispatch
 *  paths pass lean documents, and asking for the whole IUser would make them fetch more.
 *  `project` is left loose because a lean document yields an ObjectId and a request body a
 *  string — both are compared through String(), so neither is privileged.
 *
 *  **Lean, and that is now correctness rather than cost.** A grid is read row by row, and a row the
 *  stored document does not mention is the signal that nobody has been asked about it. Hydrating
 *  the document first would have Mongoose materialise that row from the sub-schema's own `false`
 *  defaults, which is indistinguishable from an answered "no" — and the row would fall silent with
 *  nothing to say so. */
export interface PrefsSource {
  emailNotifications?: boolean;
  notifications?: {
    defaults?: NotificationMatrix;
    projects?: { project: unknown; matrix: NotificationMatrix }[];
    chat?: { kind?: PersonalChatKind | ""; webhookUrl?: string };
  } | null;
}

const OFF: NotificationChannels = { inApp: false, email: false, chat: false };

export function blankMatrix(): NotificationMatrix {
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [type, { ...OFF }])
  ) as NotificationMatrix;
}

/** What a row nobody has answered for is worth.
 *
 *  task_created is the exception, and deliberately so. The other rows describe work the reader is
 *  already attached to — their own task, or one they watch; this one is every task anybody opens
 *  on the board. Handing it the legacy "bell on" would subscribe every existing account to a
 *  firehose it never asked for, by the act of adding the row. So it starts off everywhere and only
 *  a tick turns it on. */
function unanswered(type: NotificationType, email: boolean): NotificationChannels {
  return type === "task_created" ? { ...OFF } : { inApp: true, email, chat: false };
}

/** What an account that has never opened the screen gets: the bell as it has always behaved, and
 *  mail exactly where the old boolean put it. Nothing is written to reach this state. */
function legacyMatrix(emailNotifications: boolean): NotificationMatrix {
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [type, unanswered(type, emailNotifications)])
  ) as NotificationMatrix;
}

/**
 * A stored grid, with any row it does not mention filled in.
 *
 * A row added to the grid after this person last saved it is one they have never been asked about,
 * and blank would record it as a "no" they never gave. Without mail, though: they HAVE answered
 * that question for every row they saw, and a new row is not consent to be written to.
 *
 * It cuts the other way for somebody who went through the screen and unticked everything: they
 * gave a fairly clear answer to "do you want the bell", and this hands them one row of it back.
 * That is the price of the choice, taken because the alternative silences the row for everybody
 * who ever touched their settings — a larger group, and the one most likely to notice the gap.
 *
 * Both stored grids come through here. A project override is a grid somebody saved just as much as
 * the global one, and filling only the global one left the new row silent on exactly the boards
 * its owner had taken the trouble to tune.
 */
function answered(stored: NotificationMatrix): NotificationMatrix {
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [type, stored[type] ?? unanswered(type, false)])
  ) as NotificationMatrix;
}

export function defaultMatrix(user: PrefsSource | null | undefined): NotificationMatrix {
  const stored = user?.notifications?.defaults;
  return stored ? answered(stored) : legacyMatrix(!!user?.emailNotifications);
}

function overrideFor(
  user: PrefsSource | null | undefined,
  projectId: string
): NotificationMatrix | undefined {
  const row = user?.notifications?.projects?.find((p) => String(p.project) === String(projectId));
  return row?.matrix;
}

export function hasOverride(user: PrefsSource | null | undefined, projectId: string): boolean {
  return overrideFor(user, projectId) !== undefined;
}

/** The grid this project actually obeys — its own if it has one, otherwise the global one. Also
 *  what the project screen seeds a fresh override from. */
export function matrixInForce(
  user: PrefsSource | null | undefined,
  projectId: string
): NotificationMatrix {
  const own = overrideFor(user, projectId);
  return own ? answered(own) : defaultMatrix(user);
}

/** Delivery to chat needs a service AND an address; either alone sends nothing and says nothing. */
export function chatConnected(user: PrefsSource | null | undefined): boolean {
  const chat = user?.notifications?.chat;
  return !!chat?.kind && !!chat?.webhookUrl;
}

export function resolveChannels(
  user: PrefsSource | null | undefined,
  projectId: string,
  type: NotificationType
): NotificationChannels {
  const row = matrixInForce(user, projectId)[type] ?? { ...OFF };
  // Whether chat can deliver is derived from the connection, not stored beside it. Writing it into
  // the grids meant disconnecting had to rewrite the global grid and every project override, and
  // every attempt at that rewrite cost something: a wholesale $set regenerated subdocument ids, a
  // row-by-row one wrote by an index another request could shift, and the screen disabled the
  // checkbox that would have undone whichever state it left behind. Nothing is rewritten now — a
  // tick with no connection simply resolves to false, and starts working again if one appears.
  return row.chat && !chatConnected(user) ? { ...row, chat: false } : row;
}

/**
 * Whether any grid this person has — the global one or any project's — lets mail through. The
 * digest asks this before building anything, and it has to consider the overrides: mail switched
 * off globally and on for one project is a real answer, and the immediate mail is already
 * suppressed for a digest subscriber.
 */
export function wantsMailSomewhere(user: PrefsSource | null | undefined): boolean {
  const grids = [defaultMatrix(user), ...(user?.notifications?.projects ?? []).map((p) => p.matrix)];
  return grids.some((grid) => NOTIFICATION_TYPES.some((type) => grid?.[type]?.email));
}

/** Strips chat from every row — what disconnecting a service has to do to the grids that named it. */
export function withoutChat(matrix: NotificationMatrix): NotificationMatrix {
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [type, { ...matrix[type], chat: false }])
  ) as NotificationMatrix;
}

/** Whether a grid asks for chat anywhere — the one thing that needs a connection to exist first. */
export function wantsChat(matrix: NotificationMatrix): boolean {
  return NOTIFICATION_TYPES.some((type) => matrix[type]?.chat);
}

/** Whatever a client sent, reduced to a grid of exactly the rows we know and exactly booleans. */
export function normaliseMatrix(input: unknown): NotificationMatrix {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => {
      const row = (source[type] && typeof source[type] === "object" ? source[type] : {}) as Record<
        string,
        unknown
      >;
      return [
        type,
        {
          inApp: row.inApp === true,
          email: row.email === true,
          chat: row.chat === true,
        },
      ];
    })
  ) as NotificationMatrix;
}
