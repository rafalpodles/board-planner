import { NextResponse } from "next/server";
import { CONFIRMATIONS_PER_WINDOW, cancelEmailChange, issueEmailChange, pendingEmailChange } from "@/lib/email-change";
import { isEmailConfigured } from "@/lib/email";
import { withAuth } from "@/lib/middleware";
import { originFor } from "@/lib/organisation-host";
import { countAttempt, sourceKey } from "@/lib/rate-limit";
import { sendAddressConfirmation } from "@/lib/security-mail";

// The address that will receive reset links is not a machine's business, as on PUT /api/users/me
const interactiveOnly = () =>
  NextResponse.json({ error: "This action requires an interactive session" }, { status: 403 });

export const GET = withAuth(async (_request, { user, db }) => {
  if (user.viaMachineCredential) return interactiveOnly();
  const stored = await db.User.findById(user._id).select("emailVerifiedAt emailVouchedByAdmin").lean();
  return NextResponse.json({
    pending: await pendingEmailChange(db, user._id),
    confirmed: !!stored?.emailVerifiedAt && !stored.emailVouchedByAdmin,
  });
});

export const DELETE = withAuth(async (_request, { user, db }) => {
  if (user.viaMachineCredential) return interactiveOnly();
  await cancelEmailChange(db, user._id);
  return NextResponse.json({ pending: null });
});

export const POST = withAuth(async (_request, { user, db }) => {
  if (user.viaMachineCredential || user.kind === "machine") return interactiveOnly();
  if (!user.email) {
    return NextResponse.json({ error: "This account has no address to confirm. Add one first." }, { status: 409 });
  }
  if (!isEmailConfigured()) {
    return NextResponse.json({ error: "This instance cannot send mail, so it cannot send a confirmation link. Ask an administrator." }, { status: 503 });
  }
  if (await pendingEmailChange(db, user._id)) {
    return NextResponse.json({ error: "A change of address is waiting for its link. Finish or cancel it first." }, { status: 409 });
  }
  const stored = await db.User.findById(user._id).select("emailVerifiedAt emailVouchedByAdmin").lean();
  if (stored?.emailVerifiedAt && !stored.emailVouchedByAdmin) return NextResponse.json({ confirmed: true });

  const origin = await originFor(db);
  if (!origin) {
    return NextResponse.json({ error: "This instance does not know its own address, so it cannot send a confirmation link" }, { status: 503 });
  }
  if ((await countAttempt(sourceKey(String(user._id), "email-confirm"))) > CONFIRMATIONS_PER_WINDOW) {
    return NextResponse.json({ error: "Too many confirmation emails. Try again in 15 minutes." }, { status: 429 });
  }

  const token = await issueEmailChange(db, user._id, user.email);
  void sendAddressConfirmation({
    email: user.email,
    username: user.username,
    confirmUrl: `${origin}/confirm-email#token=${encodeURIComponent(token)}`,
    alreadyOnTheAccount: true,
  });
  return NextResponse.json({ sent: user.email });
});
