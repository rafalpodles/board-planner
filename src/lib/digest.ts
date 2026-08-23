import { connectDB } from "@/lib/db";
import { APP_NAME } from "@/lib/brand";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { renderEmail } from "@/lib/email-template";
import { selfOrigin } from "@/lib/session";
import { dayKeyInTimezone, hourInTimezone, isValidTimezone } from "@/lib/time";
import { taskPath } from "@/lib/urls";
import { Notification } from "@/models/notification";
import { User } from "@/models/user";
import { resolveChannels, wantsMailSomewhere, PrefsSource } from "@/lib/notification-prefs";

const TICK_MS = Number(process.env.DIGEST_TICK_MS) || 5 * 60 * 1000;
const DEFAULT_TIMEZONE = "Europe/Warsaw";

/** How many lines the mail carries before it says "and N more". */
export const DIGEST_ROW_LIMIT = 25;
/** How deep into a day's unread rows the digest will read before giving up on counting. */
export const DIGEST_SCAN_LIMIT = 500;

export function digestHour(): number {
  const raw = Math.trunc(Number(process.env.DIGEST_HOUR));
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 23) : 7;
}

export function digestTimezone(): string {
  const configured = process.env.DIGEST_TIMEZONE?.trim();
  return configured && isValidTimezone(configured) ? configured : DEFAULT_TIMEZONE;
}

/** The day whose digest is due now, or null before the hour it goes out. */
export function dueDigestDay(now: Date, timezone = digestTimezone()): string | null {
  return hourInTimezone(now, timezone) >= digestHour() ? dayKeyInTimezone(now, timezone) : null;
}

interface DigestLine {
  key: string;
  title: string;
  url?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lineFor(notification: any, origin: string | null): DigestLine {
  const task = notification.task;
  const project = notification.project;
  const hasRef = Boolean(project?.key && task?.taskNumber);
  const key = hasRef ? `${project.key}-${task.taskNumber}` : "";
  // The notification title leads with the same key the row is labelled with, so "TP-2 assigned to
  // you" would print the key twice on one line
  const title = key && notification.title.startsWith(`${key} `)
    ? notification.title.slice(key.length + 1)
    : notification.title;
  return {
    key: key || "—",
    title,
    url: origin && hasRef ? `${origin}${taskPath(project.key, task.taskNumber)}` : undefined,
  };
}

/**
 * Everything that happened on this person's tasks since yesterday's digest, as one message.
 *
 * Unread only: an in-app notification they have already opened is not news by morning, and a
 * digest that repeats it teaches people to skip the digest.
 */
export async function buildDigestFor(
  userId: string,
  since: Date,
  prefs?: PrefsSource
): Promise<{ lines: DigestLine[]; total: number; atLeast: boolean }> {
  const filter = { recipient: userId, read: false, createdAt: { $gte: since } };
  // Which rows belong in the mail is decided per row below, so a page of DIGEST_ROW_LIMIT could be
  // DIGEST_ROW_LIMIT muted ones — but reading the day unbounded lets anyone who can comment on a
  // watched task decide how much this process hydrates at 07:00. DIGEST_SCAN_LIMIT is the ceiling
  // on that; past it the count says "at least", because nobody counted the rest.
  // Newest first, so the ceiling below drops the oldest rather than everything recent. Ascending
  // meant that past the ceiling a reader saw only the start of their day and never what just
  // happened — the opposite of what a morning summary is for.
  const notifications = await Notification.find(filter)
    .sort({ createdAt: -1 })
    .limit(DIGEST_SCAN_LIMIT + 1)
    .populate("task", "taskNumber")
    .populate("project", "key")
    .lean();
  const truncated = notifications.length > DIGEST_SCAN_LIMIT;
  if (truncated) notifications.length = DIGEST_SCAN_LIMIT;

  // A project muted in the mail column drops out here too. Without this, muting would silence the
  // mail during the day and deliver it anyway the next morning.
  const wanted = notifications.filter((n) => {
    const projectId = (n.project as { _id?: unknown })?._id ?? n.project;
    return resolveChannels(prefs, String(projectId), n.type).email;
  });

  const origin = selfOrigin();
  if (truncated) {
    console.warn(`Digest for ${userId} scanned the first ${DIGEST_SCAN_LIMIT} unread rows only`);
  }
  return {
    lines: wanted.slice(0, DIGEST_ROW_LIMIT).map((n) => lineFor(n, origin)),
    // Counted rather than inferred from the page: a digest that lists 25 and says "and 1 more"
    // when 40 are waiting is a silent cap wearing a number
    total: wanted.length,
    // Past the scan ceiling this count is a floor, and the mail has to say so rather than print a
    // precise-looking number nobody computed
    atLeast: truncated,
  };
}

async function sendDigest(
  user: { _id: unknown; email: string; username: string },
  lines: DigestLine[],
  total: number,
  atLeast = false
): Promise<void> {
  const origin = selfOrigin();
  const settingsUrl = origin ? `${origin}/settings/notifications` : undefined;
  const hidden = total - lines.length;
  // Past the scan ceiling nobody counted the rest, so the headline says so too — putting "at least"
  // only in the "and N more" line left the subject and heading printing an exact figure, and that
  // line does not even render when everything that survived the filter fitted.
  const count = `${atLeast ? "at least " : ""}${total} update${total === 1 ? "" : "s"}`;

  const { html, text } = renderEmail({
    preheader: `${count} on your tasks.`,
    kicker: "Daily digest",
    heading: `${count} on your tasks`,
    rows: lines.map((line) => ({ label: line.key, value: line.title, url: line.url })),
    proseRows: true,
    outro:
      hidden > 0
        ? [`And ${atLeast ? "at least " : ""}${hidden} more waiting on the board.`]
        : undefined,
    button: origin ? { label: "Open my tasks", url: `${origin}/my-tasks` } : undefined,
    footer: [
      "You get one digest a day instead of a mail for every event, because that is what you asked for.",
    ],
    footerLinks: settingsUrl
      ? [{ label: "Email notification settings", url: settingsUrl }]
      : undefined,
  });

  await sendEmail({
    to: user.email,
    subject: `[${APP_NAME}] ${count} on your tasks`,
    text,
    html,
    headers: settingsUrl ? { "List-Unsubscribe": `<${settingsUrl}>` } : undefined,
  });
}

export async function digestTick(now = new Date()): Promise<number> {
  if (!isEmailConfigured()) return 0;
  const day = dueDigestDay(now);
  if (!day) return 0;

  await connectDB();
  // "Mail is on somewhere" now reads over a grid keyed by event, which Mongo 4.4 expresses badly,
  // so the query narrows to the digest switch and resolveChannels does the rest in code. One
  // source of truth beats a denormalised flag that would drift from the grid it summarises.
  const candidates = await User.find(
    {
      emailDigest: true,
      email: { $ne: "" },
      lastDigestDay: { $ne: day },
    },
    "email username emailNotifications notifications"
  ).lean();
  // Any grid that turns mail on anywhere — the global one or a project's — qualifies. Asking only
  // the global grid dropped anyone who had switched mail off globally and back on for one project:
  // the immediate mail is suppressed for a digest subscriber, so they would have got nothing at all.
  const waiting = candidates.filter((user) => wantsMailSomewhere(user));
  if (waiting.length === 0) return 0;

  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  let sent = 0;

  for (const user of waiting) {
    // Claimed before the work, and by the day rather than by a timestamp: a crash between here
    // and the send costs one digest instead of sending it from every app instance at once.
    const claimed = await User.findOneAndUpdate(
      { _id: user._id, lastDigestDay: { $ne: day } },
      { $set: { lastDigestDay: day } }
    );
    if (!claimed) continue;

    try {
      const { lines, total, atLeast } = await buildDigestFor(String(user._id), since, user);
      // A quiet day is not worth a mail saying so
      if (lines.length === 0) continue;
      await sendDigest(user, lines, total, atLeast);
      sent++;
    } catch (err) {
      console.error(`Digest failed for ${user.username}:`, err);
    }
  }

  return sent;
}

let started = false;

export function startDigestScheduler(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    digestTick().catch((err) => console.error("Digest tick failed:", err));
  }, TICK_MS).unref();
}
