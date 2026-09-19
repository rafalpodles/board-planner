import type { Types } from "mongoose";
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
import { accessibleProjectIds } from "@/lib/grants";
import type { SchedulerStart } from "@/lib/scheduler";

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
  projectIds: string[] | null,
  prefs?: PrefsSource
): Promise<{ lines: DigestLine[]; total: number; atLeast: boolean }> {
  // Two independent questions, and both have to be asked. Whether this person may still see the
  // board at all is the grant (BP-328) — this is the one channel that reads the backlog straight
  // out of the collection, so a row banked while the grant stood would be mailed the morning after
  // it was revoked. Whether they asked to hear about it is the grid, below.
  if (projectIds !== null && projectIds.length === 0) return { lines: [], total: 0, atLeast: false };

  const filter: Record<string, unknown> = {
    recipient: userId,
    read: false,
    createdAt: { $gte: since },
  };
  if (projectIds !== null) filter.project = { $in: projectIds };
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
): Promise<boolean> {
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

  return sendEmail({
    to: user.email,
    subject: `[${APP_NAME}] ${count} on your tasks`,
    text,
    html,
    headers: settingsUrl ? { "List-Unsubscribe": `<${settingsUrl}>` } : undefined,
  });
}

/**
 * How long a failing delivery keeps being retried before the reader waits for tomorrow.
 *
 * Up to an hour, because the failure this has to outlast is **greylisting**: a receiving server
 * answers a first-time sender with a 4xx and asks it to come back, conventionally in fifteen
 * minutes to an hour. A certificate renewal, a Postfix restart or a DNS blip have the same shape.
 * `sendEmail` collapses all of that into the same `false` as a permanent 550 (`email.ts`), so the
 * retry cannot tell which it has met and has to be generous enough for the recoverable one.
 *
 * *Up to*, because `MAX_DIGEST_ATTEMPTS` binds first at a short interval: at a one-minute tick the
 * reader gets twenty attempts spanning nineteen minutes, not an hour.
 *
 * A floor on the window rather than a ceiling, and the difference is worth knowing: the count is
 * denominated in ticks, and a server that *hangs* rather than refusing costs each subscriber up to
 * `socketTimeout`, so a tick can outrun its own interval and the overlap guard skips the next one.
 * On a sick server the attempts therefore span longer than an hour, not shorter. That is the right
 * direction, and `MAX_DIGEST_ATTEMPTS` still bounds what it costs (BP-659 review).
 */
export const DIGEST_RETRY_WINDOW_MS = 60 * 60 * 1000;

/**
 * The most attempts one reader's digest is worth in a day, whatever the interval says.
 *
 * The window above is the goal; this is the ceiling on what chasing it may cost. Each attempt is a
 * `buildDigestFor` of up to `DIGEST_SCAN_LIMIT` rows, two populates and an SMTP connection, so a
 * one-second tick must not turn one dead mailbox into thousands of them.
 *
 * It binds at every interval under about three minutes, and the arithmetic is worth writing down
 * rather than leaving to whoever wonders: at a one-minute tick the twenty attempts span *nineteen*
 * minutes, not an hour — n attempts cover n−1 intervals, which is the same rule the `+ 1` in
 * `digestAttemptLimit` exists to honour. That is the cost side winning, deliberately, over the
 * coverage side.
 */
export const MAX_DIGEST_ATTEMPTS = 20;

/**
 * How many of today's ticks will try a reader whose digest failed.
 *
 * Derived from the interval rather than written down as a count, because a count is denominated in
 * the wrong unit: three attempts is ten minutes at the default interval and two minutes at a
 * one-minute one, so an operator moving `DIGEST_TICK_MS` to make the digest arrive closer to the
 * hour would have silently cut the retry window with it (BP-659 review).
 *
 * **Plus one, because n attempts are spaced over n−1 intervals.** The first attempt is the tick
 * that failed; the last lands `(n − 1) × tickMs` after it. Without the `+ 1` the retrying stopped
 * one interval short of the window at every interval that is not exactly an hour — 55 minutes at
 * the default — which is inside the greylisting range this exists to outlast (BP-659 review).
 *
 * That also makes the floor a consequence rather than a special case: `ticks` is at least 1 for any
 * positive interval, so the limit is at least 2, which is one attempt and one retry. It used to be
 * `Math.max(ticks, 1)` — one attempt and no retry, the behaviour this ticket exists to remove — and
 * the end-to-end test is what caught it, because the suite pins the timer to a day and a day-long
 * interval divides to one.
 *
 * `Math.max(tickMs, 1)` is not only for a zero: `Number("-5") || default` keeps the −5, and a
 * negative interval would otherwise produce a negative limit, which refuses every retry.
 */
export function digestAttemptLimit(tickMs = TICK_MS): number {
  const ticks = Math.ceil(DIGEST_RETRY_WINDOW_MS / Math.max(tickMs, 1));
  return Math.min(ticks + 1, MAX_DIGEST_ATTEMPTS);
}

/**
 * Records that this reader's digest failed, and hands the day back if there are attempts left.
 *
 * The claim is scoped to the day this tick wrote: another instance cannot have taken it while we
 * held it, but the filter says what the write means rather than trusting that. `lastDigestDay` goes
 * back to `""` rather than being unset, which is what the schema's default and a fresh document
 * both look like.
 *
 * The count is keyed by the day it counts, so yesterday's failures expire without anybody clearing
 * them — and a delivery leaves the count where it is for the same reason, rather than spending a
 * write to tidy up a value nothing will read again.
 */
async function digestFailed(
  user: { _id: Types.ObjectId; username: string },
  day: string,
  attemptsBefore: number,
  what: string,
  cause?: unknown
): Promise<void> {
  const attempts = attemptsBefore + 1;
  const limit = digestAttemptLimit();
  const again = attempts < limit;
  // One line per failure, and it names the reader because `email.ts` does not — an operator reading
  // "Failed to send email" cannot tell a digest from a password reset. The cause rides along rather
  // than being logged separately above, which printed every build failure twice.
  const line = again
    ? `Digest for ${user.username} ${what}; releasing the day for another attempt`
    : `Digest for ${user.username} ${what}; ${attempts} of ${limit} attempts today, waiting for tomorrow`;
  if (cause === undefined) console.error(line);
  else console.error(line, cause);
  const retry = { day, attempts };
  try {
    const written = await User.updateOne(
      { _id: user._id, lastDigestDay: day },
      again ? { $set: { lastDigestDay: "", digestRetry: retry } } : { $set: { digestRetry: retry } }
    );
    // Nothing matched means the claim this tick wrote is not there any more, which the claim's own
    // filter says cannot happen — so it is worth one line rather than a silence, because the reader
    // has then lost the day and the count that was supposed to bound the retry went nowhere
    if (written.matchedCount === 0) {
      console.error(`Digest for ${user.username}: the day's claim was gone before the retry`);
    }
  } catch (err) {
    // This runs inside the loop over every subscriber, so a write that throws here must not end
    // the tick for everybody after this reader — which is the invariant one of these tests exists
    // to protect
    console.error(`Digest could not record the failure for ${user.username}:`, err);
  }
}

/**
 * Sends today's digest to everyone who has one waiting, and answers how many were **delivered**.
 *
 * Delivered, not attempted: `sendEmail` answers `false` for a refused or failed send rather than
 * throwing, and that answer used to be dropped on the floor — the count included messages no mail
 * server had taken, and the reader lost the day with it (BP-659).
 */
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
    // `role` for the grant lookup, `notifications` for the grid — the two questions the loop asks —
    // and `digestRetry` for how many of today's ticks have already tried this reader and failed
    "email username role emailNotifications notifications digestRetry"
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
    //
    // Which leaves everything that is *not* a crash. A refused send, or a database error while the
    // message was being built, used to keep the claim and end the reader's day: nothing was
    // delivered, the next tick passed them over, and by the following morning their rows had
    // fallen out of the 24-hour window and were never mailed at all (BP-659). So the claim is
    // handed back below on both paths, and the cost of that is named rather than hidden — a send
    // the transport failed to report is delivered twice. At-least-once is the right way round for
    // a summary somebody asked for; at-most-once is what silently lost it.
    const claimed = await User.findOneAndUpdate(
      { _id: user._id, lastDigestDay: { $ne: day } },
      { $set: { lastDigestDay: day } }
    );
    if (!claimed) continue;

    // Read from the candidate document rather than counted here: this loop sees a reader once per
    // tick, and the count has to survive between ticks to bound anything.
    const attemptsToday = user.digestRetry?.day === day ? (user.digestRetry.attempts ?? 0) : 0;

    try {
      const projectIds = await accessibleProjectIds(user);
      const { lines, total, atLeast } = await buildDigestFor(
        String(user._id),
        since,
        projectIds,
        user
      );
      // A quiet day is not worth a mail saying so — and the claim stays, because there was nothing
      // to deliver rather than something that failed to arrive
      if (lines.length === 0) continue;
      if (await sendDigest(user, lines, total, atLeast)) {
        sent++;
        continue;
      }
      await digestFailed(user, day, attemptsToday, "was not delivered");
    } catch (err) {
      await digestFailed(user, day, attemptsToday, "could not be built", err);
    }
  }

  return sent;
}

let started = false;
let ticking = false;

export type DigestSchedulerStart = SchedulerStart<"no mail server" | "already running">;

/**
 * Arms the timer that sends the morning digest, and says what it decided (BP-660).
 *
 * It answered `void` before, and the condition that decides whether the digest goes out at all
 * lived at the call site in `instrumentation.ts` — so nothing could assert either. Both failure
 * directions are silent: a digest that never goes out produces no error and no failing request.
 *
 * The three answers are its sibling's, `startGithubSyncScheduler`, for the reason that one has
 * them: a second `register()` — which `next dev` does on reload — is not the same as a scheduler
 * that will never run, and a log that says the same thing about both is worse than no log.
 */
export function startDigestScheduler(): DigestSchedulerStart {
  if (started) return { started: false, reason: "already running" };
  // Asked here rather than at the call site, so the decision and its reason are one testable thing
  if (!isEmailConfigured()) return { started: false, reason: "no mail server" };
  started = true;
  setInterval(() => {
    // A tick walks every subscriber and waits on a real mail server for each, so at a short
    // interval the next one can start while this one is still going — and with the day now handed
    // back on a failure, an overlapping tick can pick up a reader the first one has just released
    // and deliver twice. The sibling scheduler has carried this guard since BP-443.
    if (ticking) {
      console.warn("Digest tick skipped: the previous one is still running");
      return;
    }
    ticking = true;
    digestTick()
      .catch((err) => console.error("Digest tick failed:", err))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS).unref();
  return { started: true, tickMs: TICK_MS };
}
