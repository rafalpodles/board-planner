"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useApi } from "@/hooks/use-api";
import { useTheme } from "@/components/ThemeProvider";
import { usePollWhileVisible } from "@/hooks/use-poll-while-visible";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { SearchIconButton, SearchTrigger } from "@/components/search/SearchTrigger";
import { useMediaQuery } from "@/hooks/use-media-query";
import { isNavItemActive } from "@/lib/nav-active";
import { useProjects } from "@/hooks/use-projects";
import { ProjectTree } from "./ProjectTree";

const ICONS = {
  myTasks:
    "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
  bell: "M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9",
  search: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z",
  projects: "M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM4 10h16M10 10v10",
  settings:
    "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z",
  settingsInner: "M15 12a3 3 0 11-6 0 3 3 0 016 0z",
  logout: "M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1",
  collapse: "M9 4v16M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6z",
  chevronUp: "M5 15l7-7 7 7",
  close: "M6 18L18 6M6 6l12 12",
} as const;

const COLLAPSED_KEY = "sidebar-collapsed";

function Icon({ d, className = "" }: { d: string; className?: string }) {
  return (
    <svg
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

interface NavItemProps {
  href: string;
  icon: string;
  label: string;
  active: boolean;
  collapsed: boolean;
  badge?: React.ReactNode;
}

function NavItem({ href, icon, label, active, collapsed, badge }: NavItemProps) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={`focus-ring flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors md:min-h-0 ${
        collapsed ? "justify-center" : ""
      } ${
        active
          ? "bg-primary/15 font-semibold text-text"
          : "text-text-muted hover:bg-bg-hover hover:text-text"
      }`}
    >
      <Icon d={icon} className={`h-[17px] w-[17px] ${active ? "text-primary" : ""}`} />
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
      {!collapsed && badge}
    </Link>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1.5 ml-2.5 text-[10.5px] font-bold uppercase tracking-wider text-text-muted">
      {children}
    </h2>
  );
}

interface SidebarProps {
  mobileOpen: boolean;
  onNavigate: () => void;
  onCloseMobile: () => void;
  /** Focus goes back to whatever opened the drawer */
  menuButtonRef?: React.RefObject<HTMLElement | null>;
  onOpenImport: () => void;
  onOpenExport: () => void;
  onOpenSearch: () => void;
}

export function Sidebar({
  mobileOpen,
  onNavigate,
  onCloseMobile,
  menuButtonRef,
  onOpenImport,
  onOpenExport,
  onOpenSearch,
}: SidebarProps) {
  const { user, isAdmin, logout } = useAuth();
  const { projects, reorder } = useProjects();
  const { theme, toggle: toggleTheme } = useTheme();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const api = useApi();

  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      localStorage.setItem(COLLAPSED_KEY, prev ? "0" : "1");
      return !prev;
    });
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [menuOpen]);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const { count } = await api.get("/api/notifications/unread-count");
      setUnreadCount(count);
    } catch {
      // silent
    }
  }, [api]);

  usePollWhileVisible(fetchUnreadCount, 30_000, !!user);

  // Below md the sidebar is an overlay over the page, so it owes the page a
  // modal's contract. Above md it is part of the layout and owes it nothing.
  const asideRef = useRef<HTMLElement>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const isDrawer = isMobile && mobileOpen;

  useFocusTrap({
    active: isDrawer,
    containerRef: asideRef,
    onEscape: onCloseMobile,
    returnFocusTo: menuButtonRef,
  });

  if (!user) return null;

  // The drawer is always full width, so the icon-only rail is a desktop-only state
  const compact = collapsed && !mobileOpen;

  const isActive = (href: string) => isNavItemActive(pathname, href);

  const drawerAwareCollapseLabel = isDrawer
    ? "Close navigation"
    : compact
      ? "Expand sidebar"
      : "Collapse sidebar";

  return (
    <aside
      ref={asideRef}
      tabIndex={isDrawer ? -1 : undefined}
      role={isDrawer ? "dialog" : undefined}
      aria-modal={isDrawer ? true : undefined}
      aria-label={isDrawer ? "Navigation" : undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a")) onNavigate();
      }}
      className={`fixed inset-y-0 left-0 z-50 flex w-[260px] shrink-0 flex-col border-r border-border bg-bg-card transition-transform md:sticky md:top-0 md:z-auto md:h-dvh md:translate-x-0 md:transition-[width] ${
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      } ${compact ? "md:w-14" : "md:w-[260px]"}`}
    >
      <div
        className={`flex items-center gap-2 px-3.5 pb-2.5 pt-3.5 ${
          compact ? "justify-center px-0" : ""
        }`}
      >
        {!compact && (
          <Link
            href="/projects"
            className="focus-ring flex min-h-[44px] min-w-0 items-center gap-2 rounded md:min-h-0"
          >
            <Image src="/logo.svg" alt="" width={24} height={24} />
            <span className="truncate text-[15px] font-bold">ClaudePlanner</span>
          </Link>
        )}
        <button
          onClick={isDrawer ? onCloseMobile : toggleCollapsed}
          title={drawerAwareCollapseLabel}
          aria-label={drawerAwareCollapseLabel}
          className={`focus-ring flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text md:min-h-0 md:min-w-0 md:p-1 ${
            compact ? "" : "ml-auto"
          }`}
        >
          <Icon d={isDrawer ? ICONS.close : ICONS.collapse} className="h-4 w-4" />
        </button>
      </div>

      {!compact && <SearchTrigger onOpen={onOpenSearch} />}

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2.5 pb-2.5">
        <div>
          <NavItem
            href="/my-tasks"
            icon={ICONS.myTasks}
            label="My Tasks"
            active={isActive("/my-tasks")}
            collapsed={compact}
          />
          <NavItem
            href="/notifications"
            icon={ICONS.bell}
            label="Notifications"
            active={isActive("/notifications")}
            collapsed={compact}
            badge={
              unreadCount > 0 ? (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-solid px-1 text-[10px] font-semibold text-white">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              ) : undefined
            }
          />
          {compact && (
            <div className="flex justify-center">
              <SearchIconButton onOpen={onOpenSearch} />
            </div>
          )}
        </div>

        {compact ? (
          <NavItem
            href="/projects"
            icon={ICONS.projects}
            label="All projects"
            active={isActive("/projects")}
            collapsed
          />
        ) : (
          <ProjectTree
            projects={projects}
            pathname={pathname}
            isAdmin={isAdmin}
            onReorder={isAdmin ? reorder : undefined}
            onOpenImport={onOpenImport}
            onOpenExport={onOpenExport}
          />
        )}

        <div>
          {!compact && <GroupHeading>Instance</GroupHeading>}
          <NavItem
            href="/settings"
            icon={ICONS.settings}
            label="Settings"
            active={isActive("/settings")}
            collapsed={compact}
          />
        </div>
      </nav>

      <div className="border-t border-border p-2.5" ref={menuRef}>
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className={`focus-ring flex min-h-[44px] w-full items-center gap-2 rounded-lg p-1 text-left transition-colors hover:bg-bg-hover md:min-h-0 ${
              compact ? "justify-center" : ""
            }`}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/30 text-[11px] font-semibold uppercase">
              {user.fullName.charAt(0)}
            </span>
            {!compact && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{user.fullName}</span>
                  <span className="block truncate text-[11px] text-text-muted">{user.role}</span>
                </span>
                <Icon
                  d={ICONS.chevronUp}
                  className={`h-4 w-4 text-text-muted transition-transform ${
                    menuOpen ? "" : "rotate-180"
                  }`}
                />
              </>
            )}
          </button>

          {menuOpen && (
            <div className="absolute bottom-full left-0 z-50 mb-1 w-full min-w-40 overflow-hidden rounded-lg border border-border bg-bg-card py-1 shadow-lg">
              <Link
                href="/settings"
                onClick={() => setMenuOpen(false)}
                className="focus-ring-inset flex min-h-[44px] items-center gap-2 px-3 py-2 text-sm text-text-muted hover:bg-bg-hover hover:text-text md:min-h-0"
              >
                <Icon d={ICONS.settings} className="h-4 w-4" />
                Settings
              </Link>
              <button
                onClick={() => {
                  toggleTheme();
                  setMenuOpen(false);
                }}
                className="focus-ring-inset block min-h-[44px] w-full cursor-pointer px-3 py-2 text-left text-sm text-text-muted hover:bg-bg-hover hover:text-text md:min-h-0"
              >
                {theme === "dark" ? "Light mode" : "Dark mode"}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  logout();
                  router.replace("/login");
                }}
                className="focus-ring-inset flex min-h-[44px] w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm text-text-muted hover:bg-bg-hover hover:text-text md:min-h-0"
              >
                <Icon d={ICONS.logout} className="h-4 w-4" />
                Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
