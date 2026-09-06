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
  groups: SettingsNavGroup[];
  active: string;
  onSelect?: (id: string) => void;
  pillItems?: SettingsNavItem[];
  sidebarTop?: React.ReactNode;
  sidebarFooter?: React.ReactNode;
  children: React.ReactNode;
}

export function scrollSettingsToTop() {
  document.getElementById("main-content")?.scrollTo({ top: 0, behavior: "smooth" });
}

function DirtyDot({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      title="Unsaved changes"
      className={`h-1.5 w-1.5 shrink-0 rounded-full bg-warning ${className}`}
    />
  );
}

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
        onClick={scrollSettingsToTop}
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
        onClick={scrollSettingsToTop}
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
    <div className="-mt-6 pb-8 md:mt-0">
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

        <SectionPillsNav className="sticky -top-2 z-30 -mx-2 -mt-2 mb-3 border-b border-border bg-bg px-2 py-3 md:hidden">
          {pills.map(pill)}
        </SectionPillsNav>

        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
