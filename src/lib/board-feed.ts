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

/** The cells that count as opting in, for the query that has to find them by path. */
function subscribedTo(prefix: string): Record<string, unknown>[] {
  return [
    { [`${prefix}.inApp`]: true },
    { [`${prefix}.email`]: true },
    { [`${prefix}.chat`]: true },
  ];
}

/**
 * Everyone who asked to hear about every task on this board.
 *
 * Two filters, both of which have to be in the query rather than in code after it. Access, because
 * a cap applied to people who cannot reach the board could spend itself entirely on them and leave
 * the members who subscribed outside the limit; and the opt-in itself, for the same reason.
 *
 * The query only narrows. A project override wins over the global grid even when it wins by
 * switching the row *off*, and no filter expressed in paths can say that — so resolveChannels
 * makes the actual decision, once per candidate, exactly as it does for the other four rows.
 * The residue is that a truncated fan-out can end up a little under the cap. It takes more than
 * BOARD_FEED_FANOUT_LIMIT people on one board who subscribed globally and unsubscribed here, and
 * the alternative is a second query per creation.
 */
export async function boardFeedSubscribers(projectId: string): Promise<string[]> {
  if (!OBJECT_ID.test(projectId)) return [];

  const candidates = await User.find(
    {
      $and: [
        await projectAudienceFilter(projectId),
        {
          $or: [
            ...subscribedTo("notifications.defaults.task_created"),
            {
              "notifications.projects": {
                $elemMatch: {
                  project: new Types.ObjectId(projectId),
                  $or: subscribedTo("matrix.task_created"),
                },
              },
            },
          ],
        },
      ],
    },
    "notifications emailNotifications"
  )
    // Ordered, so the cap takes the same people every time rather than whichever the storage
    // engine happened to reach first.
    .sort({ _id: 1 })
    .limit(BOARD_FEED_FANOUT_LIMIT)
    .lean();

  if (candidates.length === BOARD_FEED_FANOUT_LIMIT) {
    console.error(
      `Board feed for project ${projectId} hit the ${BOARD_FEED_FANOUT_LIMIT}-recipient cap; ` +
        "anybody beyond it was not told about this task"
    );
  }

  return candidates
    .filter((user) => {
      const channels = resolveChannels(user, projectId, "task_created");
      return channels.inApp || channels.email || channels.chat;
    })
    .map((user) => String(user._id));
}

/**
 * Announce a created task to the people who subscribed to the board.
 *
 * Called without being awaited, like every other notification write, so nothing here may reject:
 * the subscriber lookup is a database read on a path that has already answered the request.
 */
export async function notifyBoardFeed(params: {
  taskId: string;
  projectId: string;
  actorId: string;
  title: string;
  body?: string;
  email?: NotificationEmail;
}): Promise<void> {
  try {
    const recipientIds = await boardFeedSubscribers(params.projectId);
    if (recipientIds.length === 0) return;
    await createNotifications({ ...params, type: "task_created", recipientIds });
  } catch (err) {
    console.error("Failed to notify the board feed:", err);
  }
}
