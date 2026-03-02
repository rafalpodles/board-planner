"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { useState, useRef, useEffect } from "react";

export function Navbar() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <nav className="border-b border-border bg-bg-card sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/projects" className="font-bold text-lg">
          ClaudePlanner
        </Link>

        {user && (
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
                  href="/users"
                  onClick={() => setOpen(false)}
                  className="block px-4 py-2 text-sm text-text-muted hover:text-text hover:bg-bg-hover"
                >
                  Users
                </Link>
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
        )}
      </div>
    </nav>
  );
}
