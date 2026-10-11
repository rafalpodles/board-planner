import { NextResponse } from "next/server";
import { accountExport } from "@/lib/account-export";
import { connectDB } from "@/lib/db";
import { withAuth } from "@/lib/middleware";

export const GET = withAuth(async (_request, { user, db }) => {
  await connectDB();
  if (user.viaMachineCredential || user.kind === "machine") {
    return NextResponse.json({ error: "This action requires an interactive session" }, { status: 403 });
  }
  const data = await accountExport(db, user);
  const filename = `${String(user.username).replace(/[^a-z0-9_-]/g, "")}-data-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
});
