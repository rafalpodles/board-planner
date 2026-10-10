import { NextResponse } from "next/server";
import { legalTerms } from "@/lib/legal-terms";

export function GET() {
  return NextResponse.json({ terms: legalTerms() });
}
