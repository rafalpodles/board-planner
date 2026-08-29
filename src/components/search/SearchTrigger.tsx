"use client";

import Link from "next/link";

const TRIGGER_CLASS =
  "focus-ring flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text";

function MagnifierIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
      />
    </svg>
  );
}

/**
 * The phone's way into search. A page rather than the palette: the overlay covers the whole
 * screen at this width anyway, so it reads as a page that lost its back button — Notifications
 * and My Tasks are the shape a person expects here.
 */
export function SearchPageLink() {
  return (
    <Link href="/search" aria-label="Search tasks and projects" className={TRIGGER_CLASS}>
      <MagnifierIcon />
    </Link>
  );
}
