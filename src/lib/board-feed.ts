import { Types } from "mongoose";
import { User } from "@/models/user";
import { projectAudienceFilter } from "@/lib/grants";
import { resolveChannels } from "@/lib/notification-prefs";
import { createNotifications, NotificationEmail } from "@/lib/in-app-notifications";

/**
 * `task_created` is the one row of the grid whose recipients cannot be filtered out of a list the
 * system already has. The other four start from a task — its assignee, its watchers — and ask each
 * of those people whether they want to hear. Nobody is attached to a task that has just been
 * created, so this one has to work the other way round: the tick *is* the subscription, and the
 * grid has to be searched rather than consulted.
 */

/**
 * How many people one created task may be announced to.
 *
 * A board with a large membership, all of them subscribed, turns every task creation into that
 * many notification documents plus that many mails — on a request path nothing awaits. The cap
 * bounds it; going over it is reported rather than swallowed, because a silent truncation reads
 * exactly like "everyone was told".
 */
export const BOARD_FEED_FANOUT_LIMIT = 200;

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

const CHAT_CONNECTED = {
  "notifications.chat.kind": { $nin: ["", null] },
  "notifications.chat.webhookUrl": { $nin: ["", null] },
};

type Clause = Record<string, unknown>;

function prefixed(prefix: string, clause: Clause): Clause {
  return Object.fromEntries(Object.entries(clause).map(([path, v]) => [`${prefix}.${path}`, v]));
}

/**
 * The cells that make resolveChannels answer yes, for the query that has to find them by path.
 * `within` is where the row lives relative to the user document; the chat connection never moves.
 */
function deliverable(row: string, within: (clause: Clause) => Clause): Clause[] {
  return [
    within({ [`${row}.inApp`]: true }),
    within({ [`${row}.email`]: true }),
    { $and: [within({ [`${row}.chat`]: true }), CHAT_CONNECTED] },
  ];
}

/**
 * Everyone who asked to hear about every task on this board.
 *
 * The whole of resolveChannels' verdict is in the query, not sifted afterwards, because the cap
 * is applied by the query: a candidate dropped after it — a global tick this board's override
 * switches off, a chat tick with nothing connected, the actor — would spend a place that somebody
 * who did qualify was then refused (BP-705). resolveChannels still runs on what comes back, as the
 * authority, and a disagreement between the two is logged rather than absorbed.
 */
export async function boardFeedSubscribers(
  projectId: string,
  exceptUserId?: string
): Promise<string[]> {
  if (!OBJECT_ID.test(projectId)) return [];
  const project = new Types.ObjectId(projectId);
  const override = (clause: Clause) => ({
    "notifications.projects": { $elemMatch: { project, ...prefixed("matrix", clause) } },
  });
  const noOverride = { $nor: [{ "notifications.projects": { $elemMatch: { project } } }] };
  const global = (clause: Clause) => prefixed("notifications.defaults", clause);

  const candidates = await User.find(
    {
      $and: [
        await projectAudienceFilter(projectId),
        ...(exceptUserId && OBJECT_ID.test(exceptUserId)
          ? [{ _id: { $ne: new Types.ObjectId(exceptUserId) } }]
          : []),
        {
          $or: [
            ...deliverable("task_created", override),
            { $and: [noOverride, { $or: deliverable("task_created", global) }] },
          ],
        },
      ],
    },
    "notifications emailNotifications"
  )
    // Ordered, so the cap takes the same people every time rather than whichever the storage
    // engine happened to reach first.
    .sort({ _id: 1 })
    .limit(BOARD_FEED_FANOUT_LIMIT + 1)
    .lean();

  if (candidates.length > BOARD_FEED_FANOUT_LIMIT) {
    candidates.length = BOARD_FEED_FANOUT_LIMIT;
    console.error(
      `Board feed for project ${projectId} hit the ${BOARD_FEED_FANOUT_LIMIT}-recipient cap; ` +
        "anybody beyond it was not told about this task"
    );
  }

  const subscribers = candidates.filter((user) => {
    const channels = resolveChannels(user, projectId, "task_created");
    return channels.inApp || channels.email || channels.chat;
  });
  if (subscribers.length < candidates.length) {
    console.error(
      `Board feed for project ${projectId}: ${candidates.length - subscribers.length} ` +
        "candidate(s) matched the subscriber query but not resolveChannels"
    );
  }
  return subscribers.map((user) => String(user._id));
}

/**
 * Announce a created task to the people who subscribed to the board.
 *
 * Called without being awaited, like every other notification write, so nothing here may reject:
 * the subscriber lookup is a database read on a path that has already answered the request.
 *
 * `email` is a function rather than a value because assembling it costs a query of its own — the
 * actor's name — and most boards have no subscribers at all. Passing the finished object would
 * put that query on every task creation on the instance, including the ones nobody hears about.
 */
export async function notifyBoardFeed(params: {
  taskId: string;
  projectId: string;
  actorId: string;
  title: string;
  body?: string;
  email?: () => Promise<NotificationEmail> | NotificationEmail;
}): Promise<void> {
  try {
    // Nobody hears about a task they created themselves. createNotifications refuses the actor
    // anyway and stays the authority on it; leaving them out of the query is so they neither take
    // a place under the cap nor get a mail assembled for an audience of one.
    const recipientIds = await boardFeedSubscribers(params.projectId, params.actorId);
    if (recipientIds.length === 0) return;
    await createNotifications({
      ...params,
      type: "task_created",
      recipientIds,
      email: await params.email?.(),
    });
  } catch (err) {
    console.error("Failed to notify the board feed:", err);
  }
}
