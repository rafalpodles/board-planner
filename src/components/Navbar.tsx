"use client";

import Link from "next/link";
import Image from "next/image";
import { useAuth } from "@/hooks/use-auth";
import { useApi } from "@/hooks/use-api";
import { useTheme } from "@/components/ThemeProvider";
import { useRouter } from "next/navigation";
import { useState, useRef, useEffect, useCallback } from "react";
import { ApiNotification } from "@/types";
import { CommandPalette } from "@/components/CommandPalette";

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const TYPE_ICONS: Record<string, string> = {
  task_assigned: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
  status_changed: "M9 5l7 7-7 7",
  comment_added: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
  mentioned: "M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9",
};

export function Navbar() {
  const { user, isAdmin, logout } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const router = useRouter();
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<ApiNotification[]>([]);
  const [loadingNotifs, setLoadingNotifs] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false);
      }
    }
    if (open || bellOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, bellOpen]);

  // Poll unread count
  const fetchUnreadCount = useCallback(async () => {
    try {
      const { count } = await api.get("/api/notifications/unread-count");
      setUnreadCount(count);
    } catch {
      // silent
    }
  }, [api]);

  useEffect(() => {
    if (!user) return;
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [user, fetchUnreadCount]);

  // Load notifications when bell opens
  useEffect(() => {
    if (!bellOpen) return;
    setLoadingNotifs(true);
    api
      .get("/api/notifications?limit=10")
      .then((data: ApiNotification[]) => setNotifications(data))
      .catch(() => {})
      .finally(() => setLoadingNotifs(false));
  }, [bellOpen, api]);

  async function markAllRead() {
    try {
      await api.patch("/api/notifications/read", {});
      setUnreadCount(0);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch {
      // silent
    }
  }

  function getNotificationHref(n: ApiNotification) {
    const projectId = typeof n.project === "object" ? n.project._id : n.project;
    const taskId = typeof n.task === "object" ? n.task._id : n.task;
    return `/projects/${projectId}/tasks/${taskId}`;
  }

  function handleNotificationClick(n: ApiNotification) {
    if (!n.read) {
      api.patch("/api/notifications/read", { id: n._id }).catch(() => {});
      setUnreadCount((c) => Math.max(0, c - 1));
      setNotifications((prev) =>
        prev.map((item) => (item._id === n._id ? { ...item, read: true } : item))
      );
    }
    setBellOpen(false);
  }

  return (
    <nav className="border-b border-border bg-bg-card sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/projects" className="font-bold text-lg flex items-center gap-2">
            <Image src="/logo.svg" alt="ClaudePlanner" width={24} height={24} />
            ClaudePlanner
          </Link>
          {user && (
            <>
              <Link
                href="/my-tasks"
                className="text-sm text-text-muted hover:text-text transition-colors"
              >
                My Tasks
              </Link>
              <Link
                href="/search"
                className="text-text-muted hover:text-text transition-colors flex items-center gap-1"
                title="Search (Cmd+K)"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <kbd className="hidden sm:inline text-[10px] text-text-muted bg-bg-input border border-border px-1 py-0.5 rounded font-mono">⌘K</kbd>
              </Link>
            </>
          )}
        </div>

        {user && (
          <div className="flex items-center gap-3">
            {/* Bell / Notifications */}
            <div className="relative" ref={bellRef}>
              <button
                onClick={() => setBellOpen((v) => !v)}
                className="relative text-text-muted hover:text-text transition-colors p-1"
                title="Notifications"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 bg-danger text-white text-[10px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </button>

              {bellOpen && (
                <div className="absolute right-0 mt-1 w-80 bg-bg-card border border-border rounded-lg shadow-lg z-50 overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                    <span className="text-sm font-medium">Notifications</span>
                    <div className="flex items-center gap-2">
                      {unreadCount > 0 && (
                        <button
                          onClick={markAllRead}
                          className="text-xs text-primary hover:text-primary/80"
                        >
                          Mark all read
                        </button>
                      )}
                      <Link
                        href="/notifications"
                        onClick={() => setBellOpen(false)}
                        className="text-xs text-text-muted hover:text-text"
                      >
                        View all
                      </Link>
                    </div>
                  </div>

                  <div className="max-h-80 overflow-y-auto">
                    {loadingNotifs ? (
                      <div className="flex justify-center py-4">
                        <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
                      </div>
                    ) : notifications.length === 0 ? (
                      <p className="text-sm text-text-muted text-center py-6">
                        No notifications
                      </p>
                    ) : (
                      notifications.map((n) => (
                        <Link
                          key={n._id}
                          href={getNotificationHref(n)}
                          onClick={() => handleNotificationClick(n)}
                          className={`w-full text-left px-3 py-2.5 hover:bg-bg-hover transition-colors flex items-start gap-2.5 border-b border-border/50 last:border-0 block ${
                            !n.read ? "bg-primary/5" : ""
                          }`}
                        >
                          <svg
                            className={`w-4 h-4 mt-0.5 shrink-0 ${!n.read ? "text-primary" : "text-text-muted"}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d={TYPE_ICONS[n.type] || TYPE_ICONS.comment_added}
                            />
                          </svg>
                          <div className="flex-1 min-w-0">
                            <p className={`text-xs leading-snug ${!n.read ? "font-medium text-text" : "text-text-muted"}`}>
                              {n.title}
                            </p>
                            {n.body && (
                              <p className="text-[11px] text-text-muted truncate mt-0.5">
                                {n.body}
                              </p>
                            )}
                            <p className="text-[10px] text-text-muted mt-0.5">
                              {typeof n.actor === "object" ? n.actor.fullName : ""}{" "}
                              {timeAgo(n.createdAt)}
                            </p>
                          </div>
                          {!n.read && (
                            <span className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1.5" />
                          )}
                        </Link>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* User menu */}
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setOpen((v) => !v)}
                className="text-sm text-text-muted hover:text-text min-h-[44px] flex items-center gap-1 cursor-pointer"
              >
                {user.fullName}
                <svg
                  className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {open && (
                <div className="absolute right-0 mt-1 w-40 bg-bg-card border border-border rounded-lg shadow-lg py-1 z-50">
                  <Link
                    href="/profile"
                    onClick={() => setOpen(false)}
                    className="block px-4 py-2 text-sm text-text-muted hover:text-text hover:bg-bg-hover"
                  >
                    Profile
                  </Link>
                  {isAdmin && (
                    <Link
                      href="/users"
                      onClick={() => setOpen(false)}
                      className="block px-4 py-2 text-sm text-text-muted hover:text-text hover:bg-bg-hover"
                    >
                      Users
                    </Link>
                  )}
                  <Link
                    href="/tokens"
                    onClick={() => setOpen(false)}
                    className="block px-4 py-2 text-sm text-text-muted hover:text-text hover:bg-bg-hover"
                  >
                    API Tokens
                  </Link>
                  <button
                    onClick={() => {
                      toggleTheme();
                      setOpen(false);
                    }}
                    className="block w-full text-left px-4 py-2 text-sm text-text-muted hover:text-text hover:bg-bg-hover cursor-pointer"
                  >
                    {theme === "dark" ? "Light mode" : "Dark mode"}
                  </button>
                  <button
                    onClick={() => {
                      setOpen(false);
                      logout();
                      router.replace("/login");
                    }}
                    className="block w-full text-left px-4 py-2 text-sm text-text-muted hover:text-text hover:bg-bg-hover cursor-pointer"
                  >
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <CommandPalette />
    </nav>
  );
}
