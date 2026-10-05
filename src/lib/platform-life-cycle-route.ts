import { NextResponse } from "next/server";
import type { LifeCycleRefusal } from "./organisation-life-cycle";

export function lifeCycleRefused(reason: LifeCycleRefusal): NextResponse {
  if (reason === "default_organisation") {
    return NextResponse.json({ error: "The default organisation cannot be suspended or deleted" }, { status: 409 });
  }
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
