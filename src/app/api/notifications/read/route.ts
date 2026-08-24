import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";
import { Notification } from "@/models/notification";

// Deliberately not constrained to the reader's accessible projects, unlike the two GETs beside
// it (BP-328). This route returns a constant `{ok:true}` and no content, so flipping `read` on a
// row from a board somebody has lost discloses nothing and cannot be used as an activity oracle.
// Constraining it would instead leave those rows permanently unreadable AND permanently unread.
export const PATCH = withAuth(async (request, { user }) => {
  await connectDB();

  const body = await request.json().catch(() => ({}));
  const { id } = body as { id?: unknown };

  if (id !== undefined) {
    // `id` goes straight into the query, and a JSON body carries an object as readily as a string:
    // `{ "$ne": null }` would match an arbitrary row of the reader's own, and a string that is not
    // an id throws a CastError out of here as a 500.
    if (typeof id !== "string" || !isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid notification id" }, { status: 400 });
    }

    // Mark single notification as read
    // Same guard as the branch below: a row the bell never showed cannot have been read here, and
    // marking it read would take it out of tomorrow's digest
    await Notification.findOneAndUpdate(
      { _id: id, recipient: user._id, inApp: { $ne: false } },
      { $set: { read: true } }
    );
  } else {
    // Mark all as read — only what the bell showed. A row the grid hid was never seen here, and
    // the digest lists what is unread: marking it read would drop it from tomorrow's mail.
    await Notification.updateMany(
      { recipient: user._id, read: false, inApp: { $ne: false } },
      { $set: { read: true } }
    );
  }

  return NextResponse.json({ ok: true });
});
