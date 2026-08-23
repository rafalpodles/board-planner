"use client";

import Link from "next/link";
import { PageHeader } from "@/components/shell/PageHeader";
import {
  SectionPillsNav,
  pillClass,
  useScrollActivePillIntoView,
} from "./SectionPills";

export interface SettingsNavItem {
  id: string;
  label: string;
  /** Set when the section is its own route; without it the shell asks `onSelect` to switch */
  href?: string;
  icon?: React.ReactNode;
  dirty?: boolean;
}

export interface SettingsNavGroup {
  title?: string;
  items: SettingsNavItem[];
}

interface SettingsShellProps {
  title?: string;
  subtitle?: React.ReactNode;
  /** Drives the sidebar; a surface that filters it passes `pillItems` for the unfiltered row */
  groups: SettingsNavGroup[];
  active: string;
  onSelect?: (id: string) => void;
  pillItems?: SettingsNavItem[];
  sidebarTop?: React.ReactNode;
  sidebarFooter?: React.ReactNode;
  children: React.ReactNode;
}

function DirtyDot({ className = "" }: { className?: string }) {
  return (
    <span
      title="Unsaved changes"
      className={`h-1.5 w-1.5 shrink-0 rounded-full bg-warning ${className}`}
    />
  );
}

/**
 * The layout both settings surfaces wear: page header, sticky sidebar above md, sticky pill
 * row below it. It owns the shape and nothing else — which sections exist, who may see them
 * and how switching one works stay with the caller, because the account pages are real routes
 * and the project page keeps every section mounted for its save bar.
 *
 * It exists because BP-365 pinned the pill row on one surface and left the other scrolling
 * away with the page: two hand-rolled copies of one layout only ever agree by accident.
 */
export function SettingsShell({
  title = "Settings",
  subtitle,
  groups,
  active,
  onSelect,
  pillItems,
  sidebarTop,
  sidebarFooter,
  children,
}: SettingsShellProps) {
  const activePill = useScrollActivePillIntoView(active);
  const pills = pillItems ?? groups.flatMap((g) => g.items);

  function sidebarItem(item: SettingsNavItem) {
    const isActive = item.id === active;
    const className = `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
      isActive
        ? "bg-primary/15 font-semibold text-text"
        : "text-text-muted hover:bg-bg-hover hover:text-text"
    }`;
    const inner = (
      <>
        {item.icon && (
          <span className={isActive ? "text-primary" : ""}>{item.icon}</span>
        )}
        <span className="flex-1 truncate">{item.label}</span>
        {item.dirty && <DirtyDot />}
      </>
    );

    return item.href ? (
      <Link
        key={item.id}
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        className={className}
      >
        {inner}
      </Link>
    ) : (
      <button
        key={item.id}
        onClick={() => onSelect?.(item.id)}
        aria-current={isActive ? "page" : undefined}
        className={className}
      >
        {inner}
      </button>
    );
  }

  function pill(item: SettingsNavItem) {
    const isActive = item.id === active;
    const inner = (
      <>
        {item.label}
        {item.dirty && <DirtyDot className="ml-1.5 inline-block align-middle" />}
      </>
    );

    return item.href ? (
      <Link
        key={item.id}
        ref={isActive ? activePill : undefined}
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        className={pillClass(isActive)}
      >
        {inner}
      </Link>
    ) : (
      <button
        key={item.id}
        ref={isActive ? activePill : undefined}
        onClick={() => onSelect?.(item.id)}
        aria-current={isActive ? "page" : undefined}
        className={pillClass(isActive)}
      >
        {inner}
      </button>
    );
  }

  return (
    <div className="pb-8">
      <PageHeader title={title} subtitle={subtitle} />

      <div className="md:grid md:grid-cols-[236px_minmax(0,1fr)] md:gap-7">
        <nav
          data-settings-nav="sidebar"
          className="hidden md:sticky md:top-4 md:block md:self-start"
          aria-label="Settings sections"
        >
          {sidebarTop}
          {groups.map((group, i) => (
            <div key={group.title ?? i} className="mb-4">
              {group.title && (
                <h2 className="mb-1.5 ml-2.5 text-[10.5px] font-bold uppercase tracking-wider text-text-muted">
                  {group.title}
                </h2>
              )}
              <div className="space-y-0.5">{group.items.map(sidebarItem)}</div>
            </div>
          ))}
          {sidebarFooter}
        </nav>

        {/* The scroll container is the app's `main`, which is padded `py-6`, and a sticky offset
            is measured from its padding edge — so `top-0` alone parks the row 24px down and
            leaves a band above it that page content scrolls through, sliced. Pulling the row up
            by that padding and paying it back as padding puts the pills flush against the top. */}
        <SectionPillsNav className="sticky -top-6 z-30 -mx-4 -mt-6 mb-4 border-b border-border bg-bg px-4 pb-3 pt-9 md:hidden">
          {pills.map(pill)}
        </SectionPillsNav>

        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
