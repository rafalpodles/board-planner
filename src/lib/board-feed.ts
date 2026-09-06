import { Types } from "mongoose";
import { User } from "@/models/user";
import { projectAudienceFilter } from "@/lib/grants";
import { resolveChannels } from "@/lib/notification-prefs";
import { createNotifications, NotificationEmail } from "@/lib/in-app-notifications";

export const BOARD_FEED_FANOUT_LIMIT = 200;

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

function subscribedTo(prefix: string): Record<string, unknown>[] {
  return [
    { [`${prefix}.inApp`]: true },
    { [`${prefix}.email`]: true },
    { [`${prefix}.chat`]: true },
  ];
}

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

export async function notifyBoardFeed(params: {
  taskId: string;
  projectId: string;
  actorId: string;
  title: string;
  body?: string;
  email?: () => Promise<NotificationEmail> | NotificationEmail;
}): Promise<void> {
  try {
    const recipientIds = (await boardFeedSubscribers(params.projectId)).filter(
      (id) => id !== params.actorId
    );
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
